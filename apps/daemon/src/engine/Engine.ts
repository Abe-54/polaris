/**
 * The orchestration engine: decides commands, records them, and supervises
 * each Agent Session's Harness.
 *
 *   dispatch ─▶ decide (under the commit lock) ─▶ commit ─▶ ack
 *                                                  └─▶ reactor (after commit, per-session serial)
 *   Harness events ─▶ session machine (session.ts) ─▶ commit ─▶ its effects
 *
 * An ack means the intent is recorded; the reactor opens Harnesses, captures
 * checkpoints, creates or removes Worktrees and so on. Nothing here writes
 * to the database except through `EventStore.commit`.
 *
 * This module wires the parts (see README.md): `runtime.ts` (shared state and
 * `signal`), `supervisor.ts` (Harnesses), `terminal.ts` (hand-off),
 * `worktrees.ts`, `pruning.ts` (checkpoints), `reviewCheckouts.ts`, `reactors.ts`,
 * `dispatch.ts`, `streams.ts`, `recovery.ts`, `limitResume.ts`, `autoArchive.ts` and
 * `idleCompaction.ts`.
 */
import {
  type AutoArchiveSettings,
  type CommandRejected,
  type FileError,
  GitError,
  type HostStreamItem,
  type IdleCompactionSettings,
  NotFound,
  type NotGranted,
  type ReviewCheckoutId,
  type ReviewCheckoutStatus,
  type Sequence,
  type SessionId,
  type SessionStreamItem,
  type TerminalLaunch,
  type TurnPage,
  type Turn,
} from "@polaris/protocol";
import { Context, Effect, Layer, Option, type Stream } from "effect";
import type { ServiceError } from "../services.ts";
import { registerHandoffContributor } from "../service/upgrade.ts";
import { AutoArchive } from "./autoArchive.ts";
import { Dispatcher, type DispatchInput } from "./dispatch.ts";
import { IdleCompaction } from "./idleCompaction.ts";
import { LimitResume } from "./limitResume.ts";
import { CheckpointPruning } from "./pruning.ts";
import { Reactors } from "./reactors.ts";
import { ReviewCheckouts } from "./reviewCheckouts.ts";
import { prepareForUpgrade as prepareSessionsForUpgrade, recoverOnStart } from "./recovery.ts";
import { EngineRuntime } from "./runtime.ts";
import {
  type HostSubscription,
  type SessionSubscription,
  Streams,
  type TurnPageRequest,
} from "./streams.ts";
import { SecretRequests } from "./secretRequests.ts";
import { Supervisor } from "./supervisor.ts";
import { TerminalHandoff } from "./terminal.ts";
import { Worktrees } from "./worktrees.ts";

export { EngineConfig, type EngineSettings } from "./runtime.ts";

export { SecretOutcome, type SecretRequestInput } from "../secrets/requests.ts";

export class Engine extends Context.Service<
  Engine,
  {
    /** Internal committed-Turn adapter for atomic Constellation journal batches. */
    readonly runCommittedTurn: (turn: Turn, prompt: string) => Effect.Effect<void>;
    readonly canSteerSession: (sessionId: SessionId) => Effect.Effect<boolean>;
    readonly steerCommittedInput: (sessionId: SessionId, text: string) => Effect.Effect<void>;
    readonly retireLead: (sessionId: SessionId) => Effect.Effect<void>;
    readonly recoveredTurns: ReadonlyArray<{
      readonly sessionId: SessionId;
      readonly interruptionId: string;
    }>;
    readonly dispatch: (
      input: DispatchInput
    ) => Effect.Effect<
      { readonly sequence: Sequence | null },
      CommandRejected | NotFound | NotGranted
    >;
    /** An agent's Secret Request on its Turn in flight, until answered or timed out (ADR 0089). */
    readonly requestSecret: SecretRequests["Service"]["request"];
    /** Saves a Secret Request's value and answers it `Provided`. */
    readonly provideSecret: SecretRequests["Service"]["provide"];
    readonly subscribeHost: (
      afterSequence: Sequence | null,
      options?: HostSubscription
    ) => Stream.Stream<HostStreamItem>;
    readonly subscribeSession: (
      options: SessionSubscription
    ) => Stream.Stream<SessionStreamItem, NotFound>;
    readonly readTurnPage: (options: TurnPageRequest) => Effect.Effect<TurnPage, NotFound>;
    readonly hasSession: (sessionId: SessionId) => Effect.Effect<boolean>;
    /** Whether `sessionId` is a session this Host knows and has not archived (can host its Browser). */
    readonly hostableSession: (sessionId: SessionId) => Effect.Effect<boolean>;
    /** How to launch the Harness's own TUI for a session that is In Terminal, once known. */
    readonly terminalCommand: (sessionId: SessionId) => Effect.Effect<TerminalLaunch | null>;
    /**
     * Call right before the Daemon replaces itself (execve upgrade). Harnesses that
     * live inside the Daemon process (Claude, `liveCoAttach: false`) are closed
     * cleanly: a Turn in flight ends Interrupted and its session Needs You (the
     * user continues it, as after a restart); other live sessions go Dormant and
     * resume from their cursor on the next Turn. Codex threads live in the shared
     * app-server, which outlives the Daemon, so they are left alone.
     */
    readonly prepareForUpgrade: Effect.Effect<void>;
    /** The same before a Client's Restart daemon; recovery copy says `restart` (ADR 0087). */
    readonly prepareForRestart: Effect.Effect<void>;
    /** When this Host archives Dormant sessions (`autoArchive.ts`). */
    readonly autoArchiveSettings: Effect.Effect<AutoArchiveSettings>;
    readonly setAutoArchiveSettings: (
      settings: AutoArchiveSettings
    ) => Effect.Effect<void, FileError>;
    /** The idle compaction setting this Host follows (`idleCompaction.ts`). */
    readonly idleCompactionSettings: Effect.Effect<IdleCompactionSettings>;
    readonly setIdleCompactionSettings: (
      settings: IdleCompactionSettings
    ) => Effect.Effect<void, FileError>;
    /** A Review Checkout as it is on disk now: what would block an update or removal. */
    readonly checkoutStatus: (
      checkoutId: ReviewCheckoutId
    ) => Effect.Effect<ReviewCheckoutStatus, NotFound | GitError>;
    /** For the Reviewer: a completed Risk Summary covered `head` of this checkout. */
    readonly checkoutReviewed: (
      checkoutId: ReviewCheckoutId,
      head: string,
      mergeBase: string
    ) => Effect.Effect<void, ServiceError>;
  }
>()("polaris/daemon/engine/Engine") {
  static readonly layer = Layer.effect(
    Engine,
    Effect.suspend(() => make)
  ).pipe(Layer.provide(Layer.suspend(() => EngineParts)));
}

/** The Engine's internal parts, each built once on one `EngineRuntime`. */
const EngineParts = Layer.mergeAll(Dispatcher.layer, Streams.layer).pipe(
  Layer.provide(Reactors.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      TerminalHandoff.layer,
      Worktrees.layer,
      CheckpointPruning.layer,
      ReviewCheckouts.layer
    )
  ),
  Layer.provideMerge(Supervisor.layer),
  Layer.provideMerge(SecretRequests.layer),
  Layer.provideMerge(EngineRuntime.layer),
  (parts) =>
    Layer.mergeAll(LimitResume.layer, AutoArchive.layer, IdleCompaction.layer).pipe(
      Layer.provideMerge(parts)
    )
);

const make = Effect.gen(function* () {
  const runtime = yield* EngineRuntime;
  const { dispatch } = yield* Dispatcher;
  const supervisor = yield* Supervisor;
  const streams = yield* Streams;
  const pruning = yield* CheckpointPruning;
  const checkouts = yield* ReviewCheckouts;
  const autoArchive = yield* AutoArchive;
  const idleCompaction = yield* IdleCompaction;
  const secrets = yield* SecretRequests;
  const prepareForUpgrade = prepareSessionsForUpgrade(runtime);
  const prepareForRestart = prepareSessionsForUpgrade(runtime, "restart");

  const recoveredTurns = yield* recoverOnStart(runtime);
  yield* checkouts.recover;
  yield* checkouts.followSessions;

  // Runs before every exec into a new binary; a failed exec needs nothing undone.
  // See docs/adr/0004-restart-recovery-never-continues-a-turn.md.
  yield* registerHandoffContributor({
    name: "engine",
    collect: () => Effect.succeed({ fds: {}, children: {} }),
    beforeExec: prepareForUpgrade,
  });

  yield* pruning.startSweeper;
  yield* (yield* LimitResume).start;
  yield* autoArchive.start;
  yield* idleCompaction.start;

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...runtime.live.keys()], (id) => runtime.stopHarness(id), { discard: true })
  );

  return Engine.of({
    recoveredTurns,
    runCommittedTurn: (turn, prompt) =>
      runtime
        .serially(turn.sessionId)(
          supervisor.runTurn({
            sessionId: turn.sessionId,
            turnId: turn.id,
            prompt,
            attachments: turn.attachments,
          })
        )
        .pipe(
          Effect.catchCause((c) => Effect.logError("Constellation Turn failed", c)),
          Effect.asVoid
        ),
    canSteerSession: Effect.fnUntraced(function* (sessionId) {
      const record = (yield* runtime.store.model).sessions.get(sessionId);

      if (record === undefined) return false;
      const driver = yield* runtime.registry.get(record.session.harness).pipe(Effect.option);

      return Option.isSome(driver) && driver.value.capabilities.steer;
    }),
    steerCommittedInput: (sessionId, text) =>
      runtime
        .serially(sessionId)(
          Effect.suspend(() => runtime.live.get(sessionId)?.session.steer(text) ?? Effect.void)
        )
        .pipe(Effect.catchCause((c) => Effect.logError("Constellation steer failed", c))),
    retireLead: (sessionId) =>
      Effect.all([runtime.cancelIdle(sessionId), runtime.stopHarness(sessionId)]).pipe(
        Effect.asVoid
      ),
    dispatch,
    requestSecret: secrets.request,
    provideSecret: secrets.provide,
    subscribeHost: streams.subscribeHost,
    subscribeSession: streams.subscribeSession,
    readTurnPage: streams.readTurnPage,
    hasSession: (sessionId) =>
      Effect.map(runtime.store.model, (model) => model.sessions.has(sessionId)),
    hostableSession: (sessionId) =>
      Effect.map(runtime.store.model, (model) => {
        const record = model.sessions.get(sessionId);

        return record !== undefined && record.session.state !== "archived";
      }),
    terminalCommand: (sessionId) =>
      Effect.sync(() => runtime.terminalLaunch.get(sessionId) ?? null),
    prepareForUpgrade,
    prepareForRestart,
    autoArchiveSettings: autoArchive.settings,
    setAutoArchiveSettings: autoArchive.setSettings,
    idleCompactionSettings: idleCompaction.settings,
    setIdleCompactionSettings: idleCompaction.setSettings,
    checkoutReviewed: checkouts.reviewed,
    checkoutStatus: (checkoutId) =>
      checkouts.status(checkoutId).pipe(
        Effect.catchTag("ServiceError", (error) =>
          Effect.fail(new GitError({ cwd: "", message: error.message }))
        ),
        Effect.flatMap((status) =>
          status === null
            ? Effect.fail(new NotFound({ what: "review checkout", id: checkoutId }))
            : Effect.succeed(status)
        )
      ),
  });
});
