/**
 * The event-sourced store. One SQLite database per Host holds the `events`
 * log (global, gapless `sequence`), the command receipts and the projection
 * tables; `commit` writes all three in one transaction.
 *
 * Commits are serialized (one drain writes batches of them), so the sequence is gapless and
 * the order subscribers see equals the order of commit. Subscribers are only
 * notified after the transaction commits.
 *
 * Design follows pingdotgg/t3code@de251fc (MIT), docs/internals/overview.md:
 * command receipts, projections in the same transaction as the events, and
 * reactors after commit. No code was copied.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  type CommandId,
  type Constellation,
  type CommandRejected,
  type ConstellationId,
  type ConstellationRejected,
  type DomainEvent,
  EventEnvelope,
  type NotFound,
  type NotGranted,
  Sequence,
  SessionId,
  SubagentDetail,
  type Turn,
  TurnId,
  type TurnItem,
  type Worktree,
} from "@polaris/protocol";
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Ref,
  type Scope,
  type Stream,
} from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { paths } from "../paths.ts";
import type { ServiceError } from "../services.ts";
import { StartupGraphIndex, startupSessions } from "./startupSessions.ts";
import { type EphemeralItem, LiveHub, LiveItem } from "./hub.ts";
import { MigrationsLayer } from "./migrations.ts";
import { hostOmittedEventTypes, project, type ReadModel, sessionOf, workingTurn } from "./model.ts";
import { type ContinuityStore, continuityStore } from "./continuity.ts";
import { type ReviewReads, reviewReads } from "./review.ts";
import {
  decodeEventRow,
  EventJson,
  type EventRow,
  loadModel,
  RejectionJson,
  storeError,
  SubagentJson,
  TurnItemJson,
  TurnJson,
  worktreeDetectedRows,
  writeEvent,
  writeProjection,
} from "./projection.ts";

export { type EphemeralItem, LiveItem } from "./hub.ts";

// Bun 1.3's `db.query` cache drops statements past 20 unfinalized, so `close()` keeps the
// database open and locked until they're collected; collect them once it closes (ENG-356).
const releaseDroppedStatements = Layer.effectDiscard(
  Effect.addFinalizer(() => Effect.sync(() => Bun.gc(true)))
);

export interface StoreSettings {
  /**
   * Items buffered per live subscriber. A subscriber that falls this far behind
   * (a stalled Client) is dropped: its stream ends after the items it already
   * has, and the Client resubscribes from its last sequence. Ephemeral items are
   * dropped earlier, once the buffer is half full, so they never cost a subscriber.
   */
  readonly subscriberCapacity: number;
}

export const StoreConfig = Context.Reference<StoreSettings>("polaris/daemon/store/StoreConfig", {
  defaultValue: () => ({ subscriberCapacity: 4096 }),
});

export type CommitResult =
  | {
      readonly _tag: "Committed";
      readonly envelopes: ReadonlyArray<EventEnvelope>;
      /** Sequence of the last event written; null when the command produced none. */
      readonly sequence: Sequence | null;
      readonly model: ReadModel;
    }
  | {
      /** The command id already has a receipt; nothing was written. */
      readonly _tag: "Duplicate";
      readonly sequence: Sequence | null;
    };

/** Constructors and matchers for `CommitResult`. */
export const CommitResult = Data.taggedEnum<CommitResult>();

export type Rejection = CommandRejected | NotFound | NotGranted | ConstellationRejected;

export interface CommitOptions<E extends Rejection> {
  /** Internal queued inputs retry a busy Session; successful receipts still deduplicate by commandId. */
  readonly recordRejection?: boolean;
  /** Client-chosen id; null for events the Daemon records on its own (Harness output, recovery). */
  readonly commandId: CommandId | null;
  /** Runs under the commit lock against the latest read model. */
  readonly decide: (model: ReadModel) => Effect.Effect<ReadonlyArray<DomainEvent>, E>;
}

export class EventStore extends Context.Service<
  EventStore,
  {
    readonly model: Effect.Effect<ReadModel>;
    readonly hasStartupGraphs?: (sessionId: SessionId) => boolean;
    readonly hasQueuedInputNow?: (sessionId: SessionId) => boolean;
    readonly hasQueuedInput: (sessionId: SessionId) => Effect.Effect<boolean>;
    readonly markQueuedInput: (sessionId: SessionId) => Effect.Effect<void>;
    readonly startupGraphs: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<Constellation>>;
    /**
     * Decide and commit atomically. A command id seen before returns
     * `Duplicate` (or re-fails with the original rejection) without deciding again.
     */
    readonly commit: <E extends Rejection = never>(
      options: CommitOptions<E>
    ) => Effect.Effect<CommitResult, E | ServiceError>;
    /** Successful command receipts survive the bounded Session Turn window. */
    readonly hasCommandReceipt: (id: CommandId) => Effect.Effect<boolean, ServiceError>;
    /**
     * Subscribe before reading a snapshot, so nothing committed in between is
     * missed. The subscription lives as long as the scope; `filter` keeps
     * unrelated items out of its buffer. The stream ends (without an error) if
     * the subscriber falls `subscriberCapacity` items behind; resume from the
     * last sequence seen.
     */
    readonly subscribe: (options?: {
      /** Only this session's items; cheaper than a filter, since other sessions' items skip it. */
      readonly sessionId?: SessionId;
      readonly includeConstellation?: boolean;
      readonly filter?: (item: LiveItem) => boolean;
    }) => Effect.Effect<Stream.Stream<LiveItem>, never, Scope.Scope>;
    readonly publishEphemeral: (item: EphemeralItem) => Effect.Effect<void>;
    /** Live subscribers right now (for tests and diagnostics). */
    readonly subscriberCount: Effect.Effect<number>;
    /**
     * Committed events with `after < sequence <= upTo`, in order. With a
     * session id, only that session's events; without, the Host stream's events.
     */
    readonly readConstellationEvents: (options: {
      readonly constellationId: ConstellationId;
      readonly after: number;
      readonly upTo: number;
    }) => Effect.Effect<ReadonlyArray<EventEnvelope>, ServiceError>;
    readonly readEvents: (options: {
      readonly after: number;
      readonly upTo: number;
      readonly sessionId: SessionId | null;
      readonly eventTypes?: ReadonlyArray<DomainEvent["_tag"]>;
    }) => Effect.Effect<ReadonlyArray<EventEnvelope>, ServiceError>;
    /**
     * A session's Turns from SQL, ordered by index: those with `index < beforeIndex`
     * (all when null), at most the last `limit` of them (all when null).
     */
    readonly readTurns: (options: {
      readonly sessionId: SessionId;
      readonly beforeIndex: number | null;
      readonly limit: number | null;
    }) => Effect.Effect<ReadonlyArray<Turn>, ServiceError>;
    /** One Turn of a session by its id, from SQL; null when the session has no such Turn. */
    readonly readTurn: (options: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<Turn | null, ServiceError>;
    /** The ids of each session's Turns, ordered by index, without decoding a Turn. */
    readonly readTurnIds: (
      sessionIds: ReadonlyArray<SessionId>
    ) => Effect.Effect<ReadonlyMap<SessionId, ReadonlyArray<TurnId>>, ServiceError>;
    /** The last recorded state of a Worktree, even one since removed (from its `WorktreeDetected`). */
    readonly lastKnownWorktree: (
      worktreeId: Worktree["id"]
    ) => Effect.Effect<Worktree | null, ServiceError>;
    /** Completed items of the given Turns (not their Subagents'), as of `upTo`, in completion order. */
    readonly readTurnItems: (options: {
      readonly turnIds: ReadonlyArray<TurnId>;
      readonly upTo: number;
    }) => Effect.Effect<ReadonlyMap<TurnId, ReadonlyArray<TurnItem>>, ServiceError>;
    /**
     * The Subagents the given Turns spawned, with their own items as of `upTo`.
     * A Subagent's record is its latest, which may be newer than `upTo`; the
     * `SubagentStarted`/`SubagentEnded` events after it replace it by id.
     */
    readonly readSubagents: (options: {
      readonly turnIds: ReadonlyArray<TurnId>;
      readonly upTo: number;
    }) => Effect.Effect<ReadonlyMap<TurnId, ReadonlyArray<SubagentDetail>>, ServiceError>;
    /** Risk Summaries and Verdicts, which live in SQL only (`review.ts`). */
    readonly review: ReviewReads;
    /** Read positions and drafts (`continuity.ts`), outside the log. */
    readonly continuity: ContinuityStore;
  }
>()("polaris/daemon/store/EventStore") {
  static readonly layer = Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const loaded = yield* loadModel(sql).pipe(Effect.mapError(storeError("load the read model")));
      // A commit is durable once it is in the WAL: see docs/adr/0003-wal-with-synchronous-normal.md.
      yield* sql`PRAGMA synchronous = NORMAL`.pipe(Effect.orDie);
      const modelRef = yield* Ref.make(loaded);
      const { subscriberCapacity } = yield* StoreConfig;
      const hub = new LiveHub(subscriberCapacity);
      const startupIndex = new StartupGraphIndex(loaded);
      const commit = yield* groupCommit({ sql, modelRef, hub, startupIndex });

      const readEvents = (options: {
        readonly after: number;
        readonly upTo: number;
        readonly sessionId: SessionId | null;
        readonly eventTypes?: ReadonlyArray<DomainEvent["_tag"]>;
      }) =>
        (options.sessionId === null
          ? sql<EventRow>`
              SELECT sequence, occurred_at, command_id, payload FROM events
              WHERE sequence > ${options.after} AND sequence <= ${options.upTo}
                AND event_type NOT IN ${sql.in(hostOmittedEventTypes)}
                AND ${options.eventTypes === undefined ? sql.literal("1") : sql`event_type IN ${sql.in(options.eventTypes)}`}
              ORDER BY sequence`
          : sql<EventRow>`
              SELECT sequence, occurred_at, command_id, payload FROM events
              WHERE session_id = ${options.sessionId}
                AND sequence > ${options.after} AND sequence <= ${options.upTo}
                AND ${options.eventTypes === undefined ? sql.literal("1") : sql`event_type IN ${sql.in(options.eventTypes)}`}
              ORDER BY sequence`
        ).pipe(
          Effect.map((rows) => rows.map(decodeEventRow)),
          Effect.mapError(storeError("read events"))
        );

      const readTurnItems = (options: {
        readonly turnIds: ReadonlyArray<TurnId>;
        readonly upTo: number;
      }) =>
        Effect.gen(function* () {
          if (options.turnIds.length === 0) return new Map<TurnId, Array<TurnItem>>();

          const rows = yield* sql<{ turn_id: string; item_id: string; data: string }>`
            SELECT turn_id, item_id, data FROM turn_items
            WHERE turn_id IN ${sql.in(options.turnIds)} AND sequence <= ${options.upTo}
              AND subagent_id IS NULL
            ORDER BY sequence`;

          // An item completed twice keeps its first position and its latest content.
          const byTurn = new Map<TurnId, Map<string, TurnItem>>();

          for (const row of rows) {
            const turnId = TurnId.make(row.turn_id);
            const items = byTurn.get(turnId) ?? new Map<string, TurnItem>();
            items.set(row.item_id, TurnItemJson.decode(row.data));
            byTurn.set(turnId, items);
          }

          return new Map([...byTurn].map(([turnId, items]) => [turnId, [...items.values()]]));
        }).pipe(Effect.mapError(storeError("read turn items")));

      const readSubagents = (options: {
        readonly turnIds: ReadonlyArray<TurnId>;
        readonly upTo: number;
      }) =>
        Effect.gen(function* () {
          if (options.turnIds.length === 0) return new Map<TurnId, Array<SubagentDetail>>();

          const subagents = yield* sql<{ data: string }>`
            SELECT data FROM subagents WHERE turn_id IN ${sql.in(options.turnIds)}`;

          if (subagents.length === 0) return new Map<TurnId, Array<SubagentDetail>>();

          const rows = yield* sql<{ subagent_id: string; item_id: string; data: string }>`
            SELECT subagent_id, item_id, data FROM turn_items
            WHERE turn_id IN ${sql.in(options.turnIds)} AND sequence <= ${options.upTo}
              AND subagent_id IS NOT NULL
            ORDER BY sequence`;

          // As for a Turn: an item completed twice keeps its first position and its latest content.
          const items = new Map<string, Map<string, TurnItem>>();

          for (const row of rows) {
            const own = items.get(row.subagent_id) ?? new Map<string, TurnItem>();
            own.set(row.item_id, TurnItemJson.decode(row.data));
            items.set(row.subagent_id, own);
          }

          const byTurn = new Map<TurnId, Array<SubagentDetail>>();

          for (const row of subagents) {
            const subagent = SubagentJson.decode(row.data);
            const list = byTurn.get(subagent.turnId) ?? [];
            list.push(
              new SubagentDetail({ subagent, items: [...(items.get(subagent.id)?.values() ?? [])] })
            );
            byTurn.set(subagent.turnId, list);
          }

          for (const list of byTurn.values())
            list.sort((a, b) => a.subagent.startedAt.localeCompare(b.subagent.startedAt));

          return byTurn;
        }).pipe(Effect.mapError(storeError("read subagents")));

      const readTurns = (options: {
        readonly sessionId: SessionId;
        readonly beforeIndex: number | null;
        readonly limit: number | null;
      }) =>
        sql<{ data: string }>`
          SELECT data FROM (
            SELECT data, turn_index FROM turns
            WHERE session_id = ${options.sessionId}
              AND turn_index < ${options.beforeIndex ?? Number.MAX_SAFE_INTEGER}
            ORDER BY turn_index DESC
            LIMIT ${options.limit ?? -1}
          ) ORDER BY turn_index`.pipe(
          Effect.map((rows) => rows.map((row) => TurnJson.decode(row.data))),
          Effect.mapError(storeError("read turns"))
        );

      const readTurn = (options: { readonly sessionId: SessionId; readonly turnId: TurnId }) =>
        sql<{ data: string }>`
          SELECT data FROM turns
          WHERE id = ${options.turnId} AND session_id = ${options.sessionId}`.pipe(
          Effect.map(([row]) => (row === undefined ? null : TurnJson.decode(row.data))),
          Effect.mapError(storeError("read a Turn"))
        );

      // The ids travel as one JSON parameter, so any number of sessions is one query.
      const readTurnIds = (sessionIds: ReadonlyArray<SessionId>) =>
        Effect.gen(function* () {
          const bySession = new Map<SessionId, Array<TurnId>>();

          if (sessionIds.length === 0) return bySession;

          const rows = yield* sql<{ session_id: string; id: string }>`
            SELECT session_id, id FROM turns
            WHERE session_id IN (SELECT value FROM json_each(${JSON.stringify(sessionIds)}))
            ORDER BY session_id, turn_index`;

          for (const row of rows) {
            const sessionId = SessionId.make(row.session_id);
            const ids = bySession.get(sessionId) ?? [];
            ids.push(TurnId.make(row.id));
            bySession.set(sessionId, ids);
          }

          return bySession;
        }).pipe(Effect.mapError(storeError("read Turn ids")));

      const lastKnownWorktree = (worktreeId: Worktree["id"]) =>
        worktreeDetectedRows(sql, worktreeId).pipe(
          Effect.map((rows) => {
            const event = rows[0] === undefined ? null : EventJson.decode(rows[0].payload);

            return Predicate.isTagged(event, "WorktreeDetected") ? event.worktree : null;
          }),
          Effect.mapError(storeError("read a Worktree"))
        );

      return EventStore.of({
        model: Ref.get(modelRef),
        hasStartupGraphs: (sessionId) => startupIndex.sessions.has(sessionId),
        hasQueuedInputNow: (sessionId) => startupIndex.queuedTurns.has(sessionId),
        hasQueuedInput: (sessionId) => Effect.sync(() => startupIndex.queuedTurns.has(sessionId)),
        markQueuedInput: (sessionId) =>
          Effect.map(Ref.get(modelRef), (model) => {
            const record = model.sessions.get(sessionId);
            const turn = record === undefined ? undefined : workingTurn(record);

            if (turn !== undefined) startupIndex.queuedTurns.set(sessionId, turn.id);
          }),
        startupGraphs: (sessionId) =>
          Effect.map(Ref.get(modelRef), (model) => startupIndex.graphs(model, sessionId)),
        commit,
        hasCommandReceipt: (id) =>
          sql`SELECT command_id FROM command_receipts WHERE command_id = ${id} AND rejection IS NULL`.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.mapError(storeError("read a command receipt"))
          ),
        subscribe: (options) => hub.subscribe(options),
        publishEphemeral: (item) => Effect.sync(() => hub.publish(item)),
        subscriberCount: Effect.sync(() => hub.size),
        readEvents,
        readConstellationEvents: (options) =>
          sql<EventRow>`SELECT sequence, occurred_at, command_id, payload FROM events WHERE constellation_id = ${options.constellationId} AND sequence > ${options.after} AND sequence <= ${options.upTo} ORDER BY sequence`.pipe(
            Effect.map((rows) => rows.map(decodeEventRow)),
            Effect.mapError(storeError("read Constellation events"))
          ),
        readTurns,
        readTurn,
        readTurnIds,
        lastKnownWorktree,
        readTurnItems,
        readSubagents,
        review: reviewReads(sql),
        continuity: continuityStore(sql),
      });
    })
  );

  /** A migrated SQLite database at `filename` (`:memory:` in tests). */
  static readonly layerSqlite = (filename: string) =>
    EventStore.layer.pipe(
      Layer.provide(MigrationsLayer),
      Layer.provide(SqliteClient.layer({ filename }).pipe(Layer.provide(releaseDroppedStatements))),
      Layer.orDie
    );

  /** The Host's database at `~/.polaris/state.sqlite`. */
  static readonly layerLive = Layer.unwrap(
    Effect.sync(() => {
      const file = paths().database;
      mkdirSync(dirname(file), { recursive: true });

      return EventStore.layerSqlite(file);
    })
  );
}

// ── Group commit (docs/adr/0002-group-commit.md) ────────────────────────────

interface Pending {
  readonly options: CommitOptions<Rejection>;
  readonly deferred: Deferred.Deferred<CommitResult, Rejection | ServiceError>;
  /** The caller was interrupted before its batch started: skip it. */
  abandoned: boolean;
}

type Outcome = Exit.Exit<CommitResult, Rejection | ServiceError>;

interface Receipt {
  readonly sequence: number | null;
  readonly rejection: Rejection | null;
}

/** What the store's commit writes to and publishes on. */
interface CommitTarget {
  readonly sql: SqlClient.SqlClient;
  readonly modelRef: Ref.Ref<ReadModel>;
  readonly hub: LiveHub;
  readonly startupIndex: StartupGraphIndex;
}

/** One batch in progress: the model so far, and what it will write and publish. */
interface Batch {
  readonly now: string;
  next: ReadModel;
  readonly writes: Array<Effect.Effect<unknown, SqlError.SqlError>>;
  readonly published: Array<EventEnvelope>;
  /** Receipts written earlier in this batch, not yet visible in SQL. */
  readonly receipts: Map<CommandId, Receipt>;
}

const sequenceOf = (value: number | null) => (value === null ? null : Sequence.make(value));

/** The store's `commit`: queued commits are decided in order and written one batch at a time. */
const groupCommit = ({ sql, modelRef, hub, startupIndex }: CommitTarget) =>
  Effect.gen(function* () {
    let queued: Array<Pending> = [];
    /** A drain is scheduled or running; later commits queue for it. */
    let writing = false;
    const context = yield* Effect.context<never>();

    const findReceipt = (batch: Batch, commandId: CommandId) =>
      Effect.suspend(() => {
        const known = batch.receipts.get(commandId);

        if (known !== undefined) return Effect.succeed<Receipt | undefined>(known);

        return sql<{ sequence: number | null; rejection: string | null }>`
          SELECT sequence, rejection FROM command_receipts WHERE command_id = ${commandId}`.pipe(
          Effect.map(([row]): Receipt | undefined =>
            row === undefined
              ? undefined
              : {
                  sequence: row.sequence,
                  rejection: row.rejection === null ? null : RejectionJson.decode(row.rejection),
                }
          ),
          Effect.mapError(storeError("read a command receipt"))
        );
      });

    const writeReceipt = (batch: Batch, commandId: CommandId, receipt: Receipt) => {
      batch.writes.push(
        sql`INSERT INTO command_receipts ${sql.insert({
          command_id: commandId,
          sequence: receipt.sequence,
          rejection: receipt.rejection === null ? null : RejectionJson.encode(receipt.rejection),
          recorded_at: batch.now,
        })}`
      );
      batch.receipts.set(commandId, receipt);
    };

    const rejected = (
      batch: Batch,
      commandId: CommandId | null,
      cause: Cause.Cause<Rejection>
    ): Outcome => {
      const rejection = Cause.findErrorOption(cause);

      if (commandId !== null && Option.isSome(rejection)) {
        writeReceipt(batch, commandId, { sequence: null, rejection: rejection.value });
      }

      return Exit.failCause(cause);
    };

    const committed = (
      batch: Batch,
      commandId: CommandId | null,
      events: ReadonlyArray<DomainEvent>
    ): Outcome => {
      const envelopes: Array<EventEnvelope> = [];

      for (const event of events) {
        const envelope = new EventEnvelope({
          sequence: Sequence.make(batch.next.sequence + 1),
          occurredAt: batch.now,
          commandId,
          event,
        });

        const after = project(batch.next, envelope);
        batch.writes.push(
          writeEvent(sql, envelope),
          writeProjection(sql, { before: batch.next, after }, envelope)
        );
        envelopes.push(envelope);
        batch.published.push(envelope);
        batch.next = after;
      }

      const sequence = envelopes.at(-1)?.sequence ?? null;

      if (commandId !== null) writeReceipt(batch, commandId, { sequence, rejection: null });

      return Exit.succeed(CommitResult.Committed({ envelopes, sequence, model: batch.next }));
    };

    /** Decide one command against the batch's model so far. */
    const decideOne = (batch: Batch, options: CommitOptions<Rejection>) =>
      Effect.gen(function* () {
        const { commandId } = options;

        if (commandId !== null) {
          const receipt = yield* findReceipt(batch, commandId);

          if (receipt !== undefined) {
            return receipt.rejection === null
              ? Exit.succeed(CommitResult.Duplicate({ sequence: sequenceOf(receipt.sequence) }))
              : Exit.fail(receipt.rejection);
          }
        }

        const decided = yield* Effect.exit(options.decide(batch.next));

        return Exit.isFailure(decided)
          ? rejected(batch, options.recordRejection === false ? null : commandId, decided.cause)
          : committed(batch, commandId, decided.value);
      });

    const runBatch = (pending: ReadonlyArray<Pending>) =>
      Effect.gen(function* () {
        const batch: Batch = {
          now: new Date(yield* Clock.currentTimeMillis).toISOString(),
          next: yield* Ref.get(modelRef),
          writes: [],
          published: [],
          receipts: new Map(),
        };

        const outcomes: Array<Outcome> = [];

        for (const { options } of pending) outcomes.push(yield* decideOne(batch, options));

        if (batch.writes.length > 0) {
          yield* sql
            .withTransaction(Effect.forEach(batch.writes, (write) => write, { discard: true }))
            .pipe(Effect.mapError(storeError("commit events")));
        }

        yield* Ref.update(modelRef, () => {
          for (const envelope of batch.published) startupIndex.committed(envelope.event);

          return batch.next;
        });

        for (const envelope of batch.published) {
          const event = envelope.event;
          const related = startupSessions(event, batch.next);

          hub.publish(LiveItem.Event({ envelope, sessionId: sessionOf(event) }), related);
        }

        return outcomes;
      });

    const settle = (batch: ReadonlyArray<Pending>, outcomes: ReadonlyArray<Outcome>) => {
      for (let i = 0; i < batch.length; i++) Deferred.doneUnsafe(batch[i]!.deferred, outcomes[i]!);
    };

    /** A failed batch settles each of its commands with the batch's failure. */
    const failedWith = (result: Exit.Exit<unknown, ServiceError>, size: number): Array<Outcome> =>
      Exit.isFailure(result)
        ? Array.from({ length: size }, () => Exit.failCause(result.cause))
        : [];

    const writeBatch = (taken: ReadonlyArray<Pending>) =>
      Effect.gen(function* () {
        const batch = taken.filter((pending) => !pending.abandoned);

        if (batch.length === 0) return;
        const result = yield* Effect.exit(runBatch(batch));

        if (Exit.isSuccess(result)) return settle(batch, result.value);

        if (batch.length === 1) return settle(batch, failedWith(result, 1));

        // A failed batch wrote nothing: commit its commands one by one, so one bad command only fails itself.
        for (const pending of batch) {
          const single = yield* Effect.exit(runBatch([pending]));
          settle([pending], Exit.isSuccess(single) ? single.value : failedWith(single, 1));
        }
      }).pipe(Effect.uninterruptible);

    /** Writes batches until nothing is queued. */
    const drain = Effect.gen(function* () {
      while (queued.length > 0) {
        const taken = queued;
        queued = [];
        yield* writeBatch(taken);
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          writing = false;
        })
      ),
      Effect.uninterruptible
    );

    return <E extends Rejection>(options: CommitOptions<E>) =>
      Effect.suspend(() => {
        const pending: Pending = {
          options,
          deferred: Deferred.makeUnsafe(),
          abandoned: false,
        };

        queued.push(pending);

        if (!writing) {
          // A microtask: the fibers running now queue their commits first (docs/adr/0002-group-commit.md).
          writing = true;
          queueMicrotask(() => Effect.runForkWith(context)(drain));
        }

        // SAFETY: a command id names one command, so a rejection replayed from its receipt is one its `decide` failed with.
        return Deferred.await(pending.deferred).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              pending.abandoned = true;
            })
          )
        ) as Effect.Effect<CommitResult, E | ServiceError>;
      });
  });
