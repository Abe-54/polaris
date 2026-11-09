/**
 * A remote Host's install flow as a flat state machine (`xstate/fsm`): check
 * (probe and plan), ask for the one-time approval, install or upgrade, done.
 * Pure; `Machines` runs the probes and uploads and feeds it their results.
 * The diagram is in `README.md` next to this file.
 *
 * - Only a check the user started may install. A background check (a
 *   reconnect) that finds no Daemon asks for approval instead, even when the
 *   build's SHA-256 was approved before.
 * - Upgrades need no new approval and may run on a background check; the
 *   outcome says the upgrade happened.
 * - "Not now" parks the Host until the user checks again; background checks
 *   leave it parked.
 * - A Windows install, or Start daemon, that found its sign-in task held by
 *   another Polaris home keeps its work, so only the user's take-over reruns
 *   it, with `--replace-task`; nothing takes over on its own.
 */
import type { InstallPlan, InstallTrigger } from "@polaris/client/install";
import { Match, Predicate, Schema } from "effect";
import { setup, types } from "xstate/fsm";

/** What a first install will put on the Host, for the approval card. */
export interface InstallOffer {
  readonly platform: string;
  readonly version: string;
  readonly sha256: string;
}

export type InstallWork = Extract<InstallPlan, { _tag: "Install" | "Upgrade" }>;

/** Start daemon: the installed build's `polaris install`, held for a take-over (ENG-327). */
const StartWork = Schema.TaggedStruct("Start", {});

export type StartWork = typeof StartWork.Type;

export const START_WORK: StartWork = StartWork.make({});

export const isStartWork = (work: HeldWork): work is StartWork => Predicate.isTagged(work, "Start");

/** What a take-over reruns: an install or upgrade, or a start. */
export type HeldWork = InstallWork | StartWork;

export interface InstallOutcome {
  readonly kind: "current" | "newer" | "installed" | "upgraded";
  readonly version: string;
  /** Upgrades: the version it replaced. */
  readonly from: string | null;
  /** The Daemon's report notes (e.g. the fallback supervisor, linger needing an admin). */
  readonly notes: ReadonlyArray<string>;
  /** Linux: what an administrator must run so the Daemon survives logout (linger). */
  readonly adminCommand: string | null;
}

/** Windows: the sign-in task `task` runs the Polaris home `otherHome` (null: not Polaris'). */
export interface TaskConflictView {
  readonly task: string;
  readonly otherHome: string | null;
}

export interface InstallProblem {
  /**
   * `ssh`: ssh itself failed (host key, auth, unreachable); the Connection State says why.
   * `task-conflict`: another Polaris home holds the Windows sign-in task (`conflict`).
   */
  readonly kind:
    | "unsupported"
    | "missing-build"
    | "host-setup"
    | "ssh"
    | "failed"
    | "task-conflict";
  readonly message: string;
  /** What an administrator must run on the Host (host setup, linger). */
  readonly command: string | null;
  readonly conflict?: TaskConflictView;
}

export interface InstallContext {
  readonly trigger: InstallTrigger | null;
  readonly offer: InstallOffer | null;
  readonly work: HeldWork | null;
  readonly outcome: InstallOutcome | null;
  readonly problem: InstallProblem | null;
}

export type InstallEvent =
  | { readonly type: "check"; readonly trigger: InstallTrigger }
  | {
      readonly type: "planned";
      readonly plan: InstallPlan;
      /** This Mac's own Daemon, from the app's build: an install needs no approval. */
      readonly trusted?: boolean;
    }
  | { readonly type: "approve" }
  | { readonly type: "dismiss" }
  /** The user confirmed taking over the sign-in task another Polaris home holds. */
  | { readonly type: "takeOver" }
  | { readonly type: "applied"; readonly outcome: InstallOutcome }
  | { readonly type: "failed"; readonly problem: InstallProblem }
  /** Start daemon met a sign-in task another Polaris home holds (`problem.conflict`). */
  | { readonly type: "startConflict"; readonly problem: InstallProblem }
  /** A taken-over start ran. */
  | { readonly type: "started" };

type Planned = Extract<InstallEvent, { type: "planned" }>;

const cleared = { offer: null, work: null, outcome: null, problem: null };

type Askable = InstallWork | Extract<InstallPlan, { _tag: "NeedsApproval" }>;

const offerOf = (plan: Askable): InstallOffer =>
  Match.value(plan).pipe(
    Match.tagsExhaustive({
      NeedsApproval: ({ platform, version, sha256 }) => ({ platform, version, sha256 }),
      Install: ({ build }) => ({
        platform: build.platform,
        version: build.version,
        sha256: build.sha256,
      }),
      Upgrade: ({ build }) => ({
        platform: build.platform,
        version: build.version,
        sha256: build.sha256,
      }),
    })
  );

const ask = (plan: Askable) => ({
  target: "approval" as const,
  context: { ...cleared, offer: offerOf(plan) },
});

const blocked = (problem: InstallProblem) => ({
  target: "blocked" as const,
  context: { ...cleared, problem },
});

/** A failed install; one stopped by a held sign-in task keeps its work for a take-over. */
const failedWork = ({
  context,
  event,
}: {
  context: InstallContext;
  event: { readonly problem: InstallProblem };
}) =>
  event.problem.kind === "task-conflict"
    ? {
        target: "blocked" as const,
        context: { ...cleared, work: context.work, problem: event.problem },
      }
    : blocked(event.problem);

/** A start stopped by a held sign-in task: blocked, holding the start for a take-over. */
const startConflict = ({ event }: { event: { readonly problem: InstallProblem } }) => ({
  target: "blocked" as const,
  context: { ...cleared, work: START_WORK, problem: event.problem },
});

/** Reruns the held install, only from a task conflict that kept its work. */
const takeOver = ({ context }: { context: InstallContext }) =>
  context.problem?.kind === "task-conflict" && context.work !== null
    ? { target: "installing" as const, context: { ...cleared, work: context.work } }
    : undefined;

const ready = (outcome: InstallOutcome) => ({
  target: "ready" as const,
  context: { ...cleared, outcome },
});

/** Where a plan leaves the Host; an install the user didn't start becomes a question. */
const planned = ({ context, event }: { context: InstallContext; event: Omit<Planned, "type"> }) =>
  Match.value(event.plan).pipe(
    Match.tagsExhaustive({
      NeedsApproval: (plan) => ask(plan),
      Install: (plan) =>
        context.trigger === "user" || event.trusted === true
          ? { target: "installing" as const, context: { ...cleared, work: plan } }
          : ask(plan),
      Upgrade: (plan) => ({ target: "installing" as const, context: { ...cleared, work: plan } }),
      // A check that changes nothing keeps saying what the last install or upgrade did.
      UpToDate: ({ version }) =>
        ready(
          context.outcome ?? { kind: "current", version, from: null, notes: [], adminCommand: null }
        ),
      InstalledNewer: ({ installed }) =>
        ready({ kind: "newer", version: installed, from: null, notes: [], adminCommand: null }),
      Unsupported: ({ os, arch }) =>
        blocked({
          kind: "unsupported",
          message: `Polaris doesn't run on ${os} ${arch} yet.`,
          command: null,
        }),
      MissingBuild: ({ platform }) =>
        blocked({
          kind: "missing-build",
          message: `This app carries no ${platform} daemon build.`,
          command: null,
        }),
      MissingLibraries: ({ libraries, command }) =>
        blocked({
          kind: "host-setup",
          message: `The host lacks ${libraries.join(" and ")}, which the daemon needs.`,
          command,
        }),
    })
  );

const check =
  (fromParked: boolean) =>
  ({ event }: { event: { readonly trigger: InstallTrigger } }) =>
    fromParked && event.trigger === "background"
      ? undefined
      : {
          target: "checking" as const,
          context: { offer: null, work: null, problem: null, trigger: event.trigger },
        };

export const installMachine = setup({
  schemas: {
    context: types<InstallContext>(),
    events: {
      check: types<{ readonly trigger: InstallTrigger }>(),
      planned: types<Omit<Planned, "type">>(),
      approve: types<Record<never, never>>(),
      dismiss: types<Record<never, never>>(),
      takeOver: types<Record<never, never>>(),
      applied: types<{ readonly outcome: InstallOutcome }>(),
      failed: types<{ readonly problem: InstallProblem }>(),
      startConflict: types<{ readonly problem: InstallProblem }>(),
      started: types<Record<never, never>>(),
    },
  },
}).createFSM({
  id: "install",
  initial: "idle",
  context: { trigger: null, ...cleared },
  states: {
    idle: { on: { check: check(false), startConflict } },
    checking: {
      on: {
        planned,
        failed: ({ event }) => blocked(event.problem),
      },
    },
    approval: {
      on: {
        // The approved SHA-256 is recorded first, so the user's re-check installs.
        approve: () => ({ target: "checking", context: { ...cleared, trigger: "user" } }),
        dismiss: ({ context }) => ({ target: "dismissed", context: { offer: context.offer } }),
        check: check(true),
        startConflict,
      },
    },
    dismissed: { on: { check: check(true), startConflict } },
    installing: {
      on: {
        applied: ({ event }) => ready(event.outcome),
        failed: failedWork,
        started: () => ({ target: "idle" as const, context: { trigger: null, ...cleared } }),
      },
    },
    ready: { on: { check: check(false), startConflict } },
    blocked: { on: { check: check(false), takeOver, startConflict } },
  },
});

export type InstallSnapshot = typeof installMachine.initialState;

export type InstallStep = InstallSnapshot["value"];

export const initialInstall = (): InstallSnapshot => installMachine.initialState;

export const stepInstall = (snapshot: InstallSnapshot, event: InstallEvent): InstallSnapshot =>
  installMachine.transition(snapshot, event)[0];
