/**
 * What the tab knows about each worker beyond the graph: its session (Harness, Model, Host),
 * liveness from session events (never the model), and attention signals.
 */
import type { HarnessKind, PhaseWaiting, ToolCallReference } from "@polaris/protocol";
import type { Plain } from "../../../store/plain.ts";
import type { SetupFact } from "./setup.ts";
import type { AttemptData } from "./types.ts";

/** What a worker is doing right now, from its session's items. */
export type Activity =
  | { readonly kind: "command"; readonly text: string; readonly since: string }
  | { readonly kind: "tool"; readonly text: string; readonly since: string }
  /** Queued for a worker slot on its Host (`__workers`, over the Host's cap). */
  | { readonly kind: "slot"; readonly host: string | null; readonly since: string }
  | {
      readonly kind: "lease";
      readonly resource: string;
      /** The Task holding it, when one does. */
      readonly holder: string | null;
      readonly since: string;
    };

export interface WorkerFacts {
  readonly harness: HarnessKind | null;
  /** The Model as the Harness names it, lowercase ("gpt-6.1-sol"). */
  readonly model: string | null;
  /** The worker's Host label when it isn't the Lead's Host. */
  readonly remoteHost: string | null;
  /** The worker's Host is Reconnecting or Offline (stale). */
  readonly hostAway: "reconnecting" | "offline" | null;
  readonly activity: Activity | null;
  readonly contextPercent: number | null;
  readonly queued: number;
  /** When the worker last produced output, shown while nothing runs. */
  readonly quietSince: string | null;
  /** Since when an approval has waited on the user, if one does. */
  readonly approvalSince: string | null;
  /** The approval waiting is a Secret Request, answered only in the worker's card. */
  readonly approvalSecret?: boolean;
  /** The worker ended without a Claim after its one nudge. */
  readonly stoppedWithoutClaiming: boolean;
  /** Whether the worker's session has a Turn in flight; null when no Daemon has said. */
  readonly activeTurn: boolean | null;
  /** Whether the Attempt's first Turn (its brief) has started; null when no Daemon has said. */
  readonly firstTurn: boolean | null;
  /** Since when the worker has held its Host's worker slot (`__workers` lease), if it does. */
  readonly slotHeldSince: string | null;
  /** The Daemon's Waiting on Background Work (`WorkerLiveness.waiting`); null when it isn't. */
  readonly waiting: PhaseWaiting | null;
  /** Subagents still working in the worker's session (rail nodes under its Attempt). */
  readonly subagents: ReadonlyArray<SubagentFact>;
}

export interface SubagentFact {
  readonly id: string;
  readonly title: string;
  /** The kind of helper as the Harness names it ("Explore"), when known. */
  readonly agent: string | null;
  readonly since: string;
}

export const NO_FACTS: WorkerFacts = {
  harness: null,
  model: null,
  remoteHost: null,
  hostAway: null,
  activity: null,
  contextPercent: null,
  queued: 0,
  quietSince: null,
  approvalSince: null,
  stoppedWithoutClaiming: false,
  activeTurn: null,
  firstTurn: null,
  slotHeldSince: null,
  waiting: null,
  subagents: [],
};

/** A verified receipt's tool call, resolved from the session that ran it. */
export interface ReceiptResult {
  readonly command: string;
  readonly exitCode: number | null;
}

export interface Facts {
  readonly now: number;
  readonly worker: (attempt: AttemptData) => WorkerFacts;
  readonly receipt: (ref: Plain<ToolCallReference>) => ReceiptResult | null;
  /** The Task's latest worktree setup run, on whichever Host's worker Session ran it. */
  readonly setup: (taskId: string) => SetupFact | null;
  /** The Lead's own Harness and Model (Gate rows) and how full its context is. */
  readonly lead: {
    readonly harness: HarnessKind | null;
    readonly model: string | null;
    readonly contextPercent: number | null;
  };
}

export const plainFacts = (patch: Partial<Facts> = {}): Facts => ({
  now: Date.now(),
  worker: () => NO_FACTS,
  receipt: () => null,
  setup: () => null,
  lead: { harness: null, model: null, contextPercent: null },
  ...patch,
});

export const CONTEXT_WARN = 85;
