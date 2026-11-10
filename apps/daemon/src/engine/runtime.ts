/**
 * The Engine's shared state and primitives: the running Harnesses, terminal
 * followers and live item progress, per-session serialization, and `signal`,
 * which runs a lifecycle input through the session machine and commits it.
 * The other engine modules are built on one `EngineRuntime`.
 */
import type {
  DomainEvent,
  SessionId,
  TerminalLaunch,
  Turn,
  TurnId,
  SubagentId,
  TurnItem,
} from "@polaris/protocol";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Scope,
  Semaphore,
} from "effect";
import type { CheckpointPolicy } from "../git/prune.ts";
import type { HarnessDriver, HarnessSession } from "../harness/HarnessDriver.ts";
import {
  AttachmentStore,
  Checkpoints,
  HarnessRegistry,
  type ServiceError,
  WorktreeTracker,
} from "../services.ts";
import { type CommitResult, EventStore } from "../store/EventStore.ts";
import { waitingOnBackgroundWork } from "./session.backgroundTasks.ts";
import type { ReadModel, SessionRecord } from "../store/model.ts";
import { decideSession, type SessionEffect, type SessionInput } from "./session.ts";
import type { ShellJob } from "./shellCommands.ts";

export type SignalResult = CommitResult & { readonly effects: ReadonlyArray<SessionEffect> };

export interface EngineSettings {
  /** How long an Idle session keeps its Harness process before going Dormant. */
  readonly idleTimeout: Duration.Input;
  /** How long a Harness may take to open for a Turn before the session Fails; default 90 seconds. */
  readonly harnessStartTimeout?: Duration.Input;
  /** Maximum silence while an Idle session waits on background work; default two hours. */
  readonly backgroundIdleTimeout?: Duration.Input;
  /** Checkpoint pruning policy (`git/prune.ts`); `DEFAULT_CHECKPOINT_POLICY` when unset. */
  readonly checkpointPolicy?: CheckpointPolicy;
  /** How often the checkpoint sweeper runs (6 hours when unset); null turns it off. */
  readonly checkpointSweepInterval?: Duration.Input | null;
  /** How long after a usage limit's reset Resume at reset continues (30 seconds when unset). */
  readonly resumeAtResetGrace?: Duration.Input;
  /** Where the auto-archive settings live (`auto-archive-settings.json` in the Polaris home when unset). */
  readonly autoArchiveSettingsPath?: string;
  /** How often the auto-archive sweep runs (hourly when unset); null turns it off. */
  readonly autoArchiveSweepInterval?: Duration.Input | null;
  /** Where the idle compaction setting lives (`idle-compaction-settings.json` in the Polaris home when unset). */
  readonly idleCompactionSettingsPath?: string;
}

export const EngineConfig = Context.Reference<EngineSettings>(
  "polaris/daemon/engine/EngineConfig",
  {
    defaultValue: () => ({ idleTimeout: Duration.minutes(30) }),
  }
);

/** Something whose `HarnessEvent`s the engine consumes: a live Harness, or a terminal follower. */
export interface EventSource {
  readonly scope: Scope.Closeable;
  /** Set when Polaris stops the source on purpose, so its exit is not treated as a crash. */
  stopping: boolean;
}

export interface LiveHarness extends EventSource {
  readonly driver: HarnessDriver;
  readonly session: HarnessSession;
  consumer: Fiber.Fiber<void> | null;
}

/** Follows a session's terminal UI while it is In Terminal (sequential hand-off). */
export interface TerminalFollower extends EventSource {
  readonly driver: HarnessDriver;
  fiber: Fiber.Fiber<void> | null;
}

/** An item still in progress, as last reported by `ItemUpdated`. */
export interface Progress {
  readonly turnId: TurnId;
  readonly item: TurnItem;
  readonly subagentId: SubagentId | null;
}

/** Events the Daemon decides on its own, from the session's latest record and the model. */
export type DecideFor = (record: SessionRecord, model: ReadModel) => ReadonlyArray<DomainEvent>;

const make = Effect.gen(function* () {
  const store = yield* EventStore;
  const config = yield* EngineConfig;
  const clock = yield* Clock.Clock;
  const idleNow = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n);
  const engineScope = yield* Effect.scope;
  const live = new Map<SessionId, LiveHarness>();
  const progress = new Map<SessionId, Map<string, Progress>>();
  const shellJobs = new Map<SessionId, ShellJob>();
  const idleTimers = yield* FiberMap.make<SessionId>();
  const sessionLocks = new Map<SessionId, Semaphore.Semaphore>();
  const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

  const serially =
    (sessionId: SessionId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
      let lock = sessionLocks.get(sessionId);

      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        sessionLocks.set(sessionId, lock);
      }

      return lock.withPermits(1)(effect);
    };

  const recordDecision = (
    sessionId: SessionId,
    f: (record: SessionRecord | undefined, model: ReadModel) => ReadonlyArray<DomainEvent>
  ) => {
    const activity = touchIdle(sessionId);

    const committed = store.commit({
      commandId: null,
      decide: (model) => {
        const record = model.sessions.get(sessionId);

        return Effect.succeed(f(record, model));
      },
    });

    return activity === null
      ? committed
      : committed.pipe(
          Effect.tap((result) =>
            "envelopes" in result && result.envelopes.length > 0 ? activity : Effect.void
          )
        );
  };

  const recordFor = (sessionId: SessionId, f: DecideFor) =>
    recordDecision(sessionId, (record, model) => (record === undefined ? [] : f(record, model)));

  const dropProgress = (sessionId: SessionId, turnId?: TurnId) => {
    const items = progress.get(sessionId);

    if (items === undefined) return;

    for (const [id, entry] of items)
      if (turnId === undefined || entry.turnId === turnId) items.delete(id);

    if (items.size === 0) progress.delete(sessionId);
  };

  const backgroundIdle = new Map<SessionId, { lastEvent: number }>();

  const cancelIdle = (sessionId: SessionId) => {
    backgroundIdle.delete(sessionId);

    return FiberMap.remove(idleTimers, sessionId);
  };

  const stopHarness = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const entry = live.get(sessionId);

      if (entry === undefined) return;
      entry.stopping = true;
      backgroundIdle.delete(sessionId);
      live.delete(sessionId);
      dropProgress(sessionId);

      if (entry.consumer !== null) yield* Fiber.interrupt(entry.consumer);
      yield* Scope.close(entry.scope, Exit.void);
    });

  const signalWith = (
    sessionId: SessionId,
    input: (record: SessionRecord | undefined) => SessionInput
  ): Effect.Effect<SignalResult, ServiceError> =>
    Effect.gen(function* () {
      let effects: ReadonlyArray<SessionEffect> = [];

      const result = yield* recordDecision(sessionId, (record) => {
        const decision = decideSession(record, input(record));
        effects = decision.effects;

        return decision.events;
      });

      for (const effect of effects) {
        if (effect === "scheduleIdleStop") yield* scheduleIdle(sessionId);
        else if (effect === "stopHarness") yield* stopHarness(sessionId);
      }

      return { ...result, effects };
    });

  const signal = (sessionId: SessionId, input: SessionInput) => signalWith(sessionId, () => input);

  const goDormant = (sessionId: SessionId, backgroundExpired: boolean) =>
    Effect.sync(() => backgroundIdle.delete(sessionId))
      .pipe(
        Effect.andThen(
          Effect.flatMap(now, (at) =>
            signalWith(sessionId, () => ({
              type: "idle.timeout",
              harnessLive: live.has(sessionId),
              backgroundExpired,
              at,
            }))
          )
        )
      )
      .pipe(Effect.catchCause((cause) => Effect.logError("idle stop failed", cause)));

  const backgroundStop = (sessionId: SessionId, activity: { lastEvent: number }) =>
    Effect.gen(function* () {
      const timeout = Duration.toMillis(config.backgroundIdleTimeout ?? Duration.hours(8));
      let remaining = timeout;

      while (true) {
        yield* Effect.sleep(Duration.millis(remaining));

        const next = yield* serially(sessionId)(
          Effect.gen(function* () {
            if (backgroundIdle.get(sessionId) !== activity) return null;
            const delay = timeout - (idleNow() - activity.lastEvent);

            if (delay > 0) return delay;
            yield* goDormant(sessionId, true);

            return null;
          })
        );

        if (next === null) return;
        remaining = next;
      }
    });

  const touchIdle = (sessionId: SessionId) => {
    const activity = backgroundIdle.get(sessionId);

    return activity === undefined
      ? null
      : Effect.sync(() => {
          if (backgroundIdle.get(sessionId) === activity) activity.lastEvent = idleNow();
        });
  };

  const scheduleIdle = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const record = (yield* store.model).sessions.get(sessionId);

      if (record === undefined) return;

      if (!waitingOnBackgroundWork(record)) {
        backgroundIdle.delete(sessionId);
        yield* FiberMap.run(
          idleTimers,
          sessionId,
          Effect.sleep(config.idleTimeout).pipe(
            Effect.andThen(serially(sessionId)(goDormant(sessionId, false)))
          )
        );

        return;
      }

      const at = idleNow();
      const existing = backgroundIdle.get(sessionId);

      if (existing !== undefined) {
        existing.lastEvent = at;

        return;
      }

      const activity = { lastEvent: at };
      backgroundIdle.set(sessionId, activity);
      yield* FiberMap.run(idleTimers, sessionId, backgroundStop(sessionId, activity));
    });

  const failSession = (sessionId: SessionId, message: string) =>
    Effect.gen(function* () {
      const at = yield* now;
      yield* Effect.logWarning(`session ${sessionId} failed: ${message}`);
      yield* signal(sessionId, { type: "session.fail", message, at });
    });

  const checkpoints = yield* Checkpoints;

  const capture = (sessionId: SessionId, turnId: TurnId, label: "before" | "after") =>
    Effect.gen(function* () {
      const model = yield* store.model;
      const record = model.sessions.get(sessionId);

      if (record === undefined) return null;

      return yield* checkpoints.capture({ cwd: record.session.cwd, sessionId, turnId, label });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`checkpoint ${label} of ${turnId} failed: ${error.message}`).pipe(
          Effect.as(null)
        )
      )
    );

  const findTurn = (sessionId: SessionId, turnId: TurnId) =>
    Effect.gen(function* () {
      const record = (yield* store.model).sessions.get(sessionId);
      const recent = record?.turns.find((t) => t.id === turnId);

      if (recent !== undefined || record === undefined) return recent ?? null;

      // Older than the Turns in memory: one row by its key (`EventStore.readTurn`).
      return yield* store.readTurn({ sessionId, turnId });
    });

  const runtime: EngineRuntime["Service"] = {
    store,
    registry: yield* HarnessRegistry,
    checkpoints,
    worktrees: yield* WorktreeTracker,
    attachmentStore: yield* AttachmentStore,
    config,
    engineScope,
    live,
    terminalLaunch: new Map(),
    followers: new Map(),
    progress,
    shellJobs,
    now,
    serially,
    recordFor,
    dropProgress,
    signal,
    signalWith,
    failSession,
    capture,
    cancelIdle,
    touchIdle,
    stopHarness,
    findTurn,
  };

  return runtime;
});

/** The shared state and primitives of one Engine; built once per `Engine.layer`. */
export class EngineRuntime extends Context.Service<
  EngineRuntime,
  {
    readonly store: EventStore["Service"];
    readonly registry: HarnessRegistry["Service"];
    readonly checkpoints: Checkpoints["Service"];
    readonly worktrees: WorktreeTracker["Service"];
    readonly attachmentStore: AttachmentStore["Service"];
    readonly config: EngineSettings;
    /** Fibers forked here live as long as the Engine. */
    readonly engineScope: Scope.Scope;
    readonly live: Map<SessionId, LiveHarness>;
    readonly terminalLaunch: Map<SessionId, TerminalLaunch>;
    readonly followers: Map<SessionId, TerminalFollower>;
    /** Items in progress per session, so a Client that subscribes mid-Turn sees them. */
    readonly progress: Map<SessionId, Map<string, Progress>>;
    /** The user's shell command per session (`RunShellCommand`), until the Harness has it. */
    readonly shellJobs: Map<SessionId, ShellJob>;
    readonly now: Effect.Effect<string>;
    /** Reactor work and Harness lifecycle changes for one session run one at a time. */
    readonly serially: (
      sessionId: SessionId
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Record events the Daemon decides on its own, against the session's latest state. */
    readonly recordFor: (
      sessionId: SessionId,
      f: DecideFor
    ) => Effect.Effect<CommitResult, ServiceError>;
    /** Forget progress of items that can no longer complete (their Turn ended, the Harness went away). */
    readonly dropProgress: (sessionId: SessionId, turnId?: TurnId) => void;
    /** Run one lifecycle input through the session machine, commit what it emits, run its effects. */
    readonly signal: (
      sessionId: SessionId,
      input: SessionInput
    ) => Effect.Effect<SignalResult, ServiceError>;
    /** `signal` with an input built from the record it is decided against. */
    readonly signalWith: (
      sessionId: SessionId,
      input: (record: SessionRecord | undefined) => SessionInput
    ) => Effect.Effect<SignalResult, ServiceError>;
    /** The Turn in flight fails and the session goes Failed. */
    readonly failSession: (
      sessionId: SessionId,
      message: string
    ) => Effect.Effect<void, ServiceError>;
    readonly capture: (
      sessionId: SessionId,
      turnId: TurnId,
      label: "before" | "after"
    ) => Effect.Effect<{ readonly ref: string; readonly commit: string } | null>;
    readonly touchIdle: (sessionId: SessionId) => Effect.Effect<void> | null;
    readonly cancelIdle: (sessionId: SessionId) => Effect.Effect<void>;
    /** Stop the Harness on purpose. Never call from the session's own event consumer. */
    readonly stopHarness: (sessionId: SessionId) => Effect.Effect<void>;
    /** A Turn of any age: recent ones are in memory, older ones in SQL. */
    readonly findTurn: (
      sessionId: SessionId,
      turnId: TurnId
    ) => Effect.Effect<Turn | null, ServiceError>;
  }
>()("polaris/daemon/engine/EngineRuntime") {
  static readonly layer = Layer.effect(EngineRuntime, make);
}
