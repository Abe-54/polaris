import { DataSource, QueryLogEntry, TableDetail, Turn, TurnId } from "@polaris/protocol";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { DataSources } from "./index.ts";
import { QueryLog } from "./queryLog.ts";
import { DataDatabase } from "./database.ts";
import { DataApprovals } from "./approvals.ts";
import { EventStore } from "../store/EventStore.ts";
import { seedDataSessionAt, started } from "./approvals.testing.ts";
import type { ResolvedSource } from "./schemaCatalog.ts";
import { SchemaStore } from "./schemaStore.ts";
import { SchemaSnapshotWorker, type SnapshotDependencies } from "./schemaSnapshots.ts";

export const source = new DataSource({
  id: "source",
  name: "app",
  engine: "postgres",
  host: "localhost",
  port: 5432,
  database: "app",
  locality: "local",
  foundIn: { kind: "env", file: ".env", key: "DATABASE_URL" },
  access: "read",
  writes: "ask",
  label: { text: "LOCAL", colour: "none" },
});

export const table = (name = "invoices") =>
  new TableDetail({
    schema: "public",
    name,
    columns: [{ name: "id", type: "integer", nullable: false, default: null, pk: true, fk: null }],
    indexes: [],
    constraints: [],
    rowEstimate: 10,
  });

export const catalog = (name = "invoices") => ({
  at: new Date().toISOString(),
  tables: [{ ...Schema.encodeSync(TableDetail)(table(name)), identity: "fixture-relation" }],
  truncated: false,
});

export const turn = started.turns[0]!;

export const nextTurn = new Turn({
  ...Schema.decodeUnknownSync(Schema.Struct(Turn.fields))(turn),
  id: TurnId.make("second"),
  index: turn.index + 1,
});

export const entry = (state: QueryLogEntry["state"] = "running") =>
  new QueryLogEntry({
    id: "q1",
    checkout: started.session.cwd,
    source: { id: source.id, name: source.name },
    target: JSON.stringify([
      source.engine,
      source.host,
      source.port,
      source.database,
      source.user ?? "",
    ]),
    sql: "select 1",
    state,
    author: { kind: "agent", sessionId: turn.sessionId, turn: turn.id },
    at: new Date().toISOString(),
  });

export const snapshotLayer = () =>
  QueryLog.layer.pipe(
    Layer.provideMerge(DataApprovals.layer),
    Layer.provideMerge(DataDatabase.layerAt(":memory:")),
    Layer.provideMerge(EventStore.layerSqlite(":memory:"))
  );

export const fixture = Effect.fnUntraced(function* (
  options: Partial<
    Pick<SnapshotDependencies, "capture" | "migrationChanged" | "migrationCheckout">
  > & { checkout?: string; resolved?: ResolvedSource } = {}
) {
  yield* seedDataSessionAt(options.checkout ?? started.session.cwd);
  const store = yield* EventStore;
  const log = yield* QueryLog;
  const { db } = yield* DataDatabase;
  let current = options.resolved?.source ?? source;
  let reads = 0;
  let found: DataSource[] = [current];
  const fail = () => Effect.die("Unexpected source mutation");

  const sources = DataSources.of({
    list: () => Effect.succeed(found),
    refresh: () => Effect.succeed(found),
    resolve: () =>
      Effect.succeed({
        source: current,
        connection: options.resolved?.connection ?? {
          tls: false,
          hostname: "localhost",
          port: 5432,
          database: "app",
          username: "user",
          password: Redacted.make(""),
        },
        matchUrl: Redacted.make("postgres://user@localhost/app"),
      }),
    watch: () => {
      throw new Error("Unexpected source watch");
    },
    save: fail,
    remove: fail,
    label: fail,
    access: fail,
  });

  const records = new SchemaStore(db);

  const workerContext = yield* Layer.build(
    SchemaSnapshotWorker.layerWith({
      sources,
      store,
      log,
      records,
      capture:
        options.capture ??
        (() =>
          Effect.sync(() => {
            reads++;

            return catalog();
          })),
      migrationChanged: options.migrationChanged ?? (() => Promise.resolve(true)),
      migrationCheckout: options.migrationCheckout ?? (() => Promise.resolve(true)),
    })
  );

  const worker = Context.get(workerContext, SchemaSnapshotWorker);

  return {
    worker,
    records,
    store,
    log,
    db,
    reads: () => reads,
    source: (value: DataSource) => {
      current = value;
      found = [value];
    },
    empty: () => {
      found = [];
    },
  };
});
