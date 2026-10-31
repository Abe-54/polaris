/** Event-driven Schema Diff worker; catalog I/O never joins decide/ack or opens approvals. */
import { Context, Effect, Layer, Predicate, Stream } from "effect";
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
import { outsideMatches } from "./outside.ts";
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

const makeSchemaSnapshots = Effect.fnUntraced(function* (deps: SnapshotDependencies) {
  const { sources, store, log, records } = deps;
  // The merged worker consumes one signal at a time; simultaneous starts share a catalog until activity.
  const shared = new Map<string, CatalogSnapshot>();

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

  const capture = Effect.fnUntraced(function* (
    resolved: ResolvedSource,
    checkout: string,
    coalesce: boolean
  ) {
    const key = JSON.stringify([checkout, targetKey(targetOf(resolved.source))]);
    const cached = coalesce ? shared.get(key) : undefined;

    if (cached) return cached;

    const result = yield* deps.capture(resolved).pipe(
      Effect.timeout(30000),
      Effect.mapError(
        () =>
          new DataError({
            code: "E-DATA-TIMEOUT",
            message: "The schema snapshot could not be completed.",
            fix: "Retry after the data source is available.",
          })
      )
    );

    shared.set(key, result);

    return result;
  });

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
        yield* capture(resolved, checkout, true).pipe(
          Effect.flatMap((before) =>
            save({
              ...existing,
              used: existing.used || used,
              before,
              baseline: "first-use",
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

    const concurrent = [...(yield* store.model).sessions.values()].some(
      (x) =>
        x.session.id !== turn.sessionId &&
        x.session.cwd === checkout &&
        x.turns.some((t) => t.status === "working")
    );

    const reuse =
      resolved.source.locality === "local" &&
      previous?.target === target &&
      !records.stale(previous) &&
      !concurrent;

    const row: SnapshotRecord = {
      sessionId: turn.sessionId,
      turn: turn.id,
      index: turn.index,
      checkout,
      source: { id: resolved.source.id, name: resolved.source.name },
      target,
      baseline: reuse ? "previous-turn-end" : baseline,
      before: reuse ? previous.after : null,
      after: null,
      used,
      failed: false,
    };

    yield* save(row);

    if (!snapshotAllowed(resolved)) {
      yield* save({ ...row, failed: true });

      return;
    }

    if (reuse) return;
    yield* capture(resolved, checkout, true).pipe(
      Effect.flatMap((before) => save({ ...row, before })),
      Effect.catch(() => save({ ...row, failed: true }))
    );
  });

  const begin = Effect.fnUntraced(function* (turn: Turn) {
    const record = (yield* store.model).sessions.get(turn.sessionId);

    if (!record) return;
    const found = yield* sources.list({ sessionId: turn.sessionId });

    if (!found.length || !(yield* Effect.promise(() => deps.migrationCheckout(record.session.cwd))))
      return;

    for (const source of found)
      if (source.locality === "local")
        yield* safely(beginSource(turn, source.id, "turn-start", false));
  });

  const touch = Effect.fnUntraced(function* (entry: DataActivity) {
    shared.clear();
    const { sessionId, turn } = entry.author;

    if (sessionId === undefined || turn === undefined) return;
    const record = (yield* store.model).sessions.get(sessionId);

    if (!record) return;
    const current = record.turns.find((t) => t.id === turn);

    if (!current) return;
    yield* beginSource(current, entry.source.id, "first-use", true);

    // An outside-command record can arrive just after TurnEnded; finish it without losing the source.
    if (current.status !== "working") yield* end(current);
  });

  const end = Effect.fnUntraced(function* (turn: Turn) {
    shared.clear();
    const rows = records.records(turn.sessionId, turn.id);

    if (!rows.length) return;
    const migration = yield* Effect.promise(() => deps.migrationChanged(rows[0]!.checkout, turn));
    const entries = records.entries(turn.sessionId, turn.id);

    for (const row of rows) {
      if (row.after) {
        yield* save({ ...row, affected: records.affected(turn.sessionId, turn.id, row.source.id) });
        continue;
      }

      const used = row.used || migration || entries.some((x) => x.source.id === row.source.id);

      if (!used) continue;
      const resolved = yield* sources.resolve({ sessionId: turn.sessionId, source: row.source.id });

      if (row.target !== targetKey(targetOf(resolved.source)) || !snapshotAllowed(resolved)) {
        yield* save({ ...row, used, failed: true });
        continue;
      }

      yield* capture(resolved, row.checkout, false).pipe(
        Effect.flatMap((after) =>
          save({
            ...row,
            used,
            after,
            affected: records.affected(turn.sessionId, turn.id, row.source.id),
          })
        ),
        Effect.catch(() => save({ ...row, used, failed: true }))
      );
    }

    shared.clear();
  });

  const outside = Effect.fnUntraced(function* (
    sessionId: SessionId,
    turnId: TurnId,
    command: string
  ) {
    if (!/\b(psql|mysql|pg_dump|mysqldump|bun|node)\b/.test(command)) return;

    const current = (yield* store.model).sessions
      .get(sessionId)
      ?.turns.find((t) => t.id === turnId);

    if (!current) return;

    for (const source of yield* sources.list({ sessionId })) {
      const resolved = yield* sources.resolve({ sessionId, source: source.id });

      if (outsideMatches(command, resolved.source, resolved.matchUrl))
        yield* beginSource(current, source.id, "first-use", true);
    }
  });

  const events = yield* store.subscribe({
    filter: (item) =>
      (Predicate.isTagged(item, "ItemProgress") &&
        Predicate.isTagged(item.item, "CommandExecution")) ||
      (Predicate.isTagged(item, "Event") &&
        (Predicate.isTagged(item.envelope.event, "TurnStarted") ||
          Predicate.isTagged(item.envelope.event, "TurnEnded"))),
  });

  const activity = yield* log.subscribe;
  yield* Stream.merge(
    events.pipe(Stream.map((item) => ({ item, entry: undefined }))),
    activity.pipe(Stream.map((entry) => ({ item: undefined, entry })))
  ).pipe(
    Stream.runForEach((signal) =>
      safely(
        Effect.gen(function* () {
          if (signal.entry) {
            yield* touch(signal.entry);

            return;
          }

          const item = signal.item;

          if (!item) return;

          if (
            Predicate.isTagged(item, "ItemProgress") &&
            Predicate.isTagged(item.item, "CommandExecution")
          ) {
            yield* outside(item.sessionId, item.turnId, item.item.command);

            return;
          }

          if (!Predicate.isTagged(item, "Event")) return;
          const event = item.envelope.event;

          if (Predicate.isTagged(event, "TurnStarted")) yield* begin(event.turn);

          if (Predicate.isTagged(event, "TurnEnded")) yield* end(event.turn);
        })
      )
    ),
    Effect.forkScoped
  );

  return {
    get: (input: { sessionId: SessionId; turn?: TurnId }) =>
      Effect.try({ try: () => records.diff(input.sessionId, input.turn), catch: storageError }),
    remove: (sessionId: SessionId) =>
      Effect.try({ try: () => records.remove(sessionId), catch: storageError }),
    begin,
    end,
    touch,
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
