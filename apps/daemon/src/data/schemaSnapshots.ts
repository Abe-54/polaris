/** Event-driven Schema Diff worker; catalog I/O never joins decide/ack or opens approvals. */
import { Context, Effect, Layer, Predicate, Semaphore, Stream } from "effect";
import {
  DataError,
  type DataSchemaDiff,
  type SessionId,
  type Turn,
  type TurnId,
} from "@polaris/protocol";
import { EventStore } from "../store/EventStore.ts";
import { DataSources } from "./index.ts";
import { DataDatabase, storageError } from "./database.ts";
import { QueryLog, type DataActivity } from "./queryLog.ts";
import { SchemaStore, type SnapshotRecord } from "./schemaStore.ts";
import { DataPools } from "./pools.ts";
import { snapshotAllowed, snapshotCatalog, type ResolvedSource } from "./schemaCatalog.ts";
import { targetKey, targetOf } from "./approvalStore.ts";
import { keyedSnapshotGate } from "./schemaLocks.ts";
import { knownSchemaCommand } from "./schemaCommands.ts";
import { migrationCheckout, migrationChanged } from "./schemaMigrations.ts";
import type { CatalogSnapshot } from "./schemaCompare.ts";

export interface SnapshotDependencies {
  readonly sources: DataSources["Service"];
  readonly store: EventStore["Service"];
  readonly log: QueryLog["Service"];
  readonly records: SchemaStore;
  readonly capture: (resolved: ResolvedSource) => Effect.Effect<CatalogSnapshot, DataError>;
  readonly migrationCheckout: (checkout: string) => Promise<boolean>;
  readonly migrationChanged: (checkout: string, turn: Turn) => Promise<boolean>;
}

const baselineKind = (
  turn: Turn,
  previous: SnapshotRecord | undefined,
  reuse: boolean,
  requested: SnapshotRecord["baseline"]
): SnapshotRecord["baseline"] => {
  if (!reuse) return turn.index > 0 ? "first-use" : requested;

  return previous?.endCaptured ? "previous-turn-end" : "first-use";
};

const makeSchemaSnapshots = Effect.fnUntraced(function* (deps: SnapshotDependencies) {
  const { sources, store, log, records } = deps;
  const captures = yield* Semaphore.make(4);
  const onTarget = keyedSnapshotGate();
  const inSession = keyedSnapshotGate();
  const usedSessions = new Set<SessionId>();
  const turnSources = new Map<TurnId, ReadonlyArray<import("@polaris/protocol").DataSource>>();
  const outsideTurns = new Set<TurnId>();

  const safely = <A>(work: Effect.Effect<A, unknown>) =>
    work.pipe(
      Effect.catchCause(() => Effect.logWarning("Couldn't capture a Schema Diff snapshot")),
      Effect.asVoid
    );

  const save = Effect.fnUntraced(function* (record: SnapshotRecord) {
    const live = (yield* store.model).sessions.get(record.sessionId);

    if (!live || live.session.state === "archived") return;
    yield* Effect.try({ try: () => records.put(record), catch: storageError });
  });

  const capture = (resolved: ResolvedSource) =>
    onTarget(
      targetKey(targetOf(resolved.source)),
      captures.withPermit(
        deps.capture(resolved).pipe(
          Effect.timeout(30000),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new DataError({
                code: "E-DATA-TIMEOUT",
                message: "The schema capture exceeded its time limit.",
                fix: "Retry after the data source is available.",
              })
            )
          )
        )
      )
    );

  const beginSource = Effect.fnUntraced(function* (
    turn: Turn,
    source: string,
    baseline: SnapshotRecord["baseline"],
    used: boolean
  ) {
    const record = (yield* store.model).sessions.get(turn.sessionId);

    if (!record || record.session.state === "archived") return;
    const checkout = record.session.cwd;
    const existing = records.records(turn.sessionId, turn.id).find((x) => x.source.id === source);
    const resolved = yield* sources.resolve({ sessionId: turn.sessionId, source });

    if (existing) {
      if (used && !existing.used) yield* save({ ...existing, used });

      if (
        !existing.before &&
        snapshotAllowed(resolved) &&
        existing.target === targetKey(targetOf(resolved.source))
      ) {
        yield* capture(resolved).pipe(
          Effect.flatMap((before) =>
            save({
              ...existing,
              used: existing.used || used,
              before,
              baseline: "first-use",
              capturedLate: before.at > turn.startedAt,
              failed: false,
            })
          ),
          Effect.ignore
        );
      }

      return;
    }

    if (baseline === "turn-start" && resolved.source.locality !== "local") return;
    const previous = records.previous(turn.sessionId, resolved.source.id, turn.index);
    const target = targetKey(targetOf(resolved.source));

    const reuse =
      resolved.source.locality === "local" &&
      previous?.target === target &&
      !records.stale(previous);

    const row: SnapshotRecord = {
      sessionId: turn.sessionId,
      turn: turn.id,
      index: turn.index,
      checkout,
      source: { id: resolved.source.id, name: resolved.source.name },
      target,
      startedAt: turn.startedAt,
      baseline: baselineKind(turn, previous, reuse, baseline),
      baselineTurn: reuse
        ? (previous.afterTurn ?? previous.baselineTurn ?? previous.turn)
        : turn.id,
      before: reuse ? previous.after : null,
      after: null,
      used,
      failed: false,
    };

    yield* save(row);

    if (!snapshotAllowed(resolved)) {
      yield* save({ ...row, failed: true, errorCode: "E-DATA-DENIED" });

      return;
    }

    if (reuse) return;
    yield* capture(resolved).pipe(
      Effect.flatMap((before) =>
        save({ ...row, before, capturedLate: before.at > turn.startedAt })
      ),
      Effect.catch((error) => save({ ...row, failed: true, errorCode: error.code }))
    );
  });

  const begin = Effect.fnUntraced(function* (turn: Turn) {
    const record = (yield* store.model).sessions.get(turn.sessionId);

    if (!record) return;

    const eligible =
      usedSessions.has(turn.sessionId) ||
      (yield* Effect.promise(() => deps.migrationCheckout(record.session.cwd)));

    if (!eligible) return;
    const found = yield* sources.list({ sessionId: turn.sessionId });
    turnSources.set(turn.id, found);

    if (!found.length) return;

    for (const source of found)
      if (source.locality === "local")
        yield* safely(beginSource(turn, source.id, "turn-start", false));
  });

  const touch = Effect.fnUntraced(function* (entry: DataActivity) {
    const { sessionId, turn } = entry.author;

    if (sessionId === undefined) return;
    usedSessions.add(sessionId);

    if (turn === undefined) return;
    const record = (yield* store.model).sessions.get(sessionId);

    if (!record) return;
    const current = record.turns.find((t) => t.id === turn);

    if (!current) return;
    yield* beginSource(current, entry.source.id, "first-use", true);

    // An outside-command record can arrive just after TurnEnded; finish it without losing the source.
    if (current.status !== "working") yield* end(current);
  });

  const finishSource = Effect.fnUntraced(function* (
    row: SnapshotRecord,
    turn: Turn,
    used: boolean,
    uncertain: boolean,
    after: CatalogSnapshot
  ) {
    const live = (yield* store.model).sessions.get(turn.sessionId);

    const overlapped =
      live?.turns.some((next) => next.index > turn.index && next.startedAt <= after.at) ?? false;

    const concurrent = records.concurrent(row, new Date().toISOString());
    yield* save({
      ...row,
      used,
      after,
      afterTurn: turn.id,
      endCaptured: true,
      concurrent,
      capturedLate: row.capturedLate || overlapped,
      uncertain: uncertain || concurrent || overlapped,
      affected: records.affected(turn.sessionId, turn.id, row.source.id),
    });
  });

  const end = Effect.fnUntraced(function* (turn: Turn) {
    const rows = records.records(turn.sessionId, turn.id);

    if (!rows.length) {
      turnSources.delete(turn.id);
      outsideTurns.delete(turn.id);

      return;
    }

    const migration = yield* Effect.promise(() => deps.migrationChanged(rows[0]!.checkout, turn));
    const entries = records.entries(turn.sessionId, turn.id);

    for (const row of rows) {
      if (row.after && row.endCaptured) {
        yield* save({ ...row, affected: records.affected(turn.sessionId, turn.id, row.source.id) });
        continue;
      }

      const used =
        row.used ||
        migration ||
        outsideTurns.has(turn.id) ||
        entries.some((x) => x.source.id === row.source.id);

      if (!used) {
        yield* save({
          ...row,
          after: row.before,
          afterTurn: row.baselineTurn ?? row.turn,
          endCaptured: false,
        });
        continue;
      }

      const resolved = yield* sources.resolve({ sessionId: turn.sessionId, source: row.source.id });

      if (row.target !== targetKey(targetOf(resolved.source)) || !snapshotAllowed(resolved)) {
        yield* save({ ...row, used, failed: true, errorCode: "E-DATA-DENIED" });
        continue;
      }

      yield* capture(resolved).pipe(
        Effect.flatMap((after) =>
          finishSource(
            row,
            turn,
            used,
            migration ||
              outsideTurns.has(turn.id) ||
              entries.some(
                (entry) =>
                  entry.source.id === row.source.id &&
                  (entry.author.kind === "outside" ||
                    (entry.state === "completed" &&
                      entry.tool?.includes("execute") &&
                      entry.affected === undefined))
              ),
            after
          )
        ),
        Effect.catch((error) => save({ ...row, used, failed: true, errorCode: error.code }))
      );
    }

    turnSources.delete(turn.id);
    outsideTurns.delete(turn.id);
  });

  const outside = Effect.fnUntraced(function* (
    sessionId: SessionId,
    turnId: TurnId,
    command: string
  ) {
    if (!knownSchemaCommand(command) || outsideTurns.has(turnId)) return;
    const record = (yield* store.model).sessions.get(sessionId);
    const current = record?.turns.find((t) => t.id === turnId);

    if (!current || !record) return;

    if (
      !usedSessions.has(sessionId) &&
      !(yield* Effect.promise(() => deps.migrationCheckout(record.session.cwd)))
    )
      return;
    outsideTurns.add(turnId);
    const found = turnSources.get(turnId) ?? (yield* sources.list({ sessionId }));
    turnSources.set(turnId, found);

    for (const source of found) {
      const resolved = yield* sources.resolve({ sessionId, source: source.id });

      records.activity(targetKey(targetOf(resolved.source)), sessionId, turnId);
      yield* beginSource(current, source.id, "first-use", true);
    }
  });

  yield* log.registerBeforeWrite((entry) =>
    entry.author.sessionId ? inSession(entry.author.sessionId, safely(touch(entry))) : Effect.void
  );

  const events = yield* store.subscribe({
    filter: (item) =>
      Predicate.isTagged(item, "Event") &&
      (Predicate.isTagged(item.envelope.event, "TurnStarted") ||
        Predicate.isTagged(item.envelope.event, "TurnEnded") ||
        Predicate.isTagged(item.envelope.event, "TurnItemCompleted")),
  });

  const activity = yield* log.subscribe;

  yield* Stream.merge(
    events.pipe(Stream.map((item) => ({ item, entry: undefined }))),
    activity.pipe(Stream.map((entry) => ({ item: undefined, entry })))
  ).pipe(
    Stream.mapEffect(
      (signal) => {
        const event =
          signal.item && Predicate.isTagged(signal.item, "Event")
            ? signal.item.envelope.event
            : undefined;

        let id = signal.entry?.author.sessionId;

        if (event && Predicate.isTagged(event, "TurnItemCompleted")) id = event.sessionId;

        if (
          event &&
          (Predicate.isTagged(event, "TurnStarted") || Predicate.isTagged(event, "TurnEnded"))
        )
          id = event.turn.sessionId;

        const work = safely(
          Effect.gen(function* () {
            if (signal.entry) {
              yield* touch(signal.entry);

              return;
            }

            const item = signal.item;

            if (!item) return;

            if (!Predicate.isTagged(item, "Event")) return;
            const event = item.envelope.event;

            if (
              Predicate.isTagged(event, "TurnItemCompleted") &&
              Predicate.isTagged(event.item, "CommandExecution")
            )
              yield* outside(event.sessionId, event.turnId, event.item.command);

            if (Predicate.isTagged(event, "TurnStarted")) yield* begin(event.turn);

            if (Predicate.isTagged(event, "TurnEnded")) yield* end(event.turn);
          })
        );

        return id ? inSession(id, work) : work;
      },
      { concurrency: 16, unordered: true }
    ),
    Stream.runDrain,
    Effect.forkScoped
  );

  return {
    get: (input: { sessionId: SessionId; turn?: TurnId }) =>
      Effect.try({ try: () => records.diff(input.sessionId, input.turn), catch: storageError }),
    remove: (sessionId: SessionId) =>
      Effect.try({
        try: () => {
          usedSessions.delete(sessionId);
          records.remove(sessionId);
        },
        catch: storageError,
      }),
    begin: (turn: Turn) => inSession(turn.sessionId, begin(turn)),
    end: (turn: Turn) => inSession(turn.sessionId, end(turn)),
    touch: (entry: DataActivity) =>
      entry.author.sessionId ? inSession(entry.author.sessionId, touch(entry)) : touch(entry),
    outside: (sessionId: SessionId, turnId: TurnId, command: string) =>
      inSession(sessionId, outside(sessionId, turnId, command)),
  };
});

export class SchemaSnapshotWorker extends Context.Service<
  SchemaSnapshotWorker,
  Effect.Success<ReturnType<typeof makeSchemaSnapshots>>
>()("polaris/data/SchemaSnapshotWorker") {
  static layerWith = (deps: SnapshotDependencies) =>
    Layer.effect(SchemaSnapshotWorker, makeSchemaSnapshots(deps));
}

export class SchemaSnapshots extends Context.Service<
  SchemaSnapshots,
  {
    readonly get: (input: {
      sessionId: SessionId;
      turn?: TurnId;
    }) => Effect.Effect<DataSchemaDiff, DataError>;
    readonly remove: (sessionId: SessionId) => Effect.Effect<void, DataError>;
  }
>()("polaris/data/SchemaSnapshots") {
  static readonly layer = Layer.effect(
    SchemaSnapshots,
    Effect.gen(function* () {
      const { db } = yield* DataDatabase;
      const sources = yield* DataSources;
      const store = yield* EventStore;
      const log = yield* QueryLog;
      const pools = new DataPools();
      yield* Effect.addFinalizer(() => Effect.promise(() => pools.close()));
      const records = yield* Effect.try({ try: () => new SchemaStore(db), catch: storageError });
      // Archived sessions and removed Workspaces cannot retain orphaned catalogs after a restart.
      const live = yield* store.model;

      for (const row of db
        .query<{ session: string }, []>("SELECT DISTINCT session FROM data_schema_snapshots")
        .all()) {
        const session = [...live.sessions.values()].find((x) => x.session.id === row.session);

        if (!session || session.session.state === "archived") records.remove(row.session);
      }

      return yield* makeSchemaSnapshots({
        sources,
        store,
        log,
        records,
        capture: (resolved) => snapshotCatalog(pools, resolved),
        migrationCheckout,
        migrationChanged,
      });
    })
  );
}
