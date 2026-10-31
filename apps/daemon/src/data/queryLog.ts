/** Checkout-scoped Query Log with bounded retention and event-driven snapshots. */
import {
  QueryLogEntry,
  type DataQueryLogPage,
  type SessionId,
  type TurnId,
} from "@polaris/protocol";
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { initializeLogRetention, pruneQueryLog } from "./logRetention.ts";
import { DataApprovals } from "./approvals.ts";
import { DataDatabase, storageError } from "./database.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(QueryLogEntry));

export interface DataActivity {
  readonly checkout: string;
  readonly source: QueryLogEntry["source"];
  readonly author: { readonly sessionId?: SessionId; readonly turn?: TurnId };
}

export class QueryLog extends Context.Service<
  QueryLog,
  {
    readonly subscribe: Effect.Effect<
      Stream.Stream<DataActivity>,
      never,
      import("effect").Scope.Scope
    >;
    readonly touch: (entry: QueryLogEntry) => Effect.Effect<void>;
    readonly put: (
      entry: QueryLogEntry,
      once?: boolean
    ) => Effect.Effect<void, import("@polaris/protocol").DataError>;
    readonly page: (
      checkout: string,
      before?: string,
      limit?: number
    ) => Effect.Effect<typeof DataQueryLogPage.Type, import("@polaris/protocol").DataError>;
    readonly watch: (
      checkout: string
    ) => Stream.Stream<ReadonlyArray<QueryLogEntry>, import("@polaris/protocol").DataError>;
  }
>()("polaris/data/QueryLog") {
  static readonly layer = Layer.effect(
    QueryLog,
    Effect.gen(function* () {
      const { db } = yield* DataDatabase;
      const approvals = yield* DataApprovals;
      yield* Effect.try({
        try: () => {
          db.exec(`CREATE TABLE IF NOT EXISTS data_query_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,checkout TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS data_query_checkout ON data_query_log(checkout,seq);
      CREATE INDEX IF NOT EXISTS data_query_author ON data_query_log(json_extract(value,'$.author.sessionId'));
      CREATE TABLE IF NOT EXISTS data_query_activity (checkout TEXT NOT NULL,session TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(checkout,session));`);
          initializeLogRetention(db);
        },
        catch: storageError,
      });
      const changes = yield* PubSub.sliding<string>(64);
      const activity = yield* PubSub.unbounded<DataActivity>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(activity));
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

      const touch = (entry: QueryLogEntry) =>
        PubSub.publish(activity, {
          checkout: entry.checkout,
          source: entry.source,
          author: {
            ...(entry.author.sessionId === undefined
              ? undefined
              : { sessionId: entry.author.sessionId }),
            ...(entry.author.turn === undefined ? undefined : { turn: entry.author.turn }),
          },
        }).pipe(Effect.asVoid);

      const page = (checkout: string, before?: string, limit = 100) =>
        Effect.try({
          try: () => {
            pruneQueryLog(db);

            const cut =
              before === undefined
                ? Number.MAX_SAFE_INTEGER
                : (db
                    .query<{ seq: number }, [string, string]>(
                      "SELECT seq FROM data_query_log WHERE checkout=? AND id=?"
                    )
                    .get(checkout, before)?.seq ?? 0);

            const rows = db
              .query<
                { value: string; status: string | null; reason: string | null },
                [string, number, number]
              >(
                "SELECT q.value,COALESCE(w.status,a.status) AS status,COALESCE(w.reason,a.reason) AS reason FROM data_query_log q LEFT JOIN data_approval_requests a ON a.id=json_extract(q.value,'$.approval.id') LEFT JOIN data_write_requests w ON w.id=json_extract(q.value,'$.approval.id') WHERE q.checkout=? AND q.seq<? ORDER BY q.seq DESC LIMIT ?"
              )
              .all(checkout, cut, Math.min(limit, 100) + 1);

            const entries = rows.slice(0, limit).map((row) => {
              const entry = decode(row.value);

              if (
                !entry.approval ||
                entry.state !== "waiting-approval" ||
                (row.status !== "approved" && row.status !== "denied")
              )
                return entry;

              return new QueryLogEntry({
                ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry),
                approval: { id: entry.approval.id, status: row.status },
                state: row.status === "denied" ? "failed" : "cancelled",
                error: row.reason ?? "The approval was answered; retry the query to run it.",
              });
            });

            return { entries, next: rows.length > limit ? entries.at(-1)!.id : null };
          },
          catch: storageError,
        });

      const put = Effect.fnUntraced(function* (entry: QueryLogEntry, once = false) {
        yield* Effect.try({
          try: () =>
            db.transaction(() => {
              const value = JSON.stringify(entry);
              db.query(
                once
                  ? "INSERT OR IGNORE INTO data_query_log(id,checkout,value,logged_at,bytes) VALUES (?,?,?,?,?)"
                  : "INSERT INTO data_query_log(id,checkout,value,logged_at,bytes) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,logged_at=excluded.logged_at,bytes=excluded.bytes"
              ).run(entry.id, entry.checkout, value, entry.at, Buffer.byteLength(value));
              db.query(
                "INSERT INTO data_query_activity VALUES (?,?,?) ON CONFLICT(checkout,session) DO UPDATE SET updated=excluded.updated"
              ).run(entry.checkout, entry.author.sessionId ?? "", new Date().toISOString());
              pruneQueryLog(db);
            })(),
          catch: storageError,
        });
        yield* PubSub.publish(changes, "*");
        yield* touch(entry);
      });

      const watch = (checkout: string) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            const initial = yield* page(checkout);

            return Stream.concat(
              Stream.succeed(initial.entries),
              Stream.merge(
                Stream.fromSubscription(subscription).pipe(
                  Stream.filter((key) => key === "*" || key === checkout)
                ),
                approvals.changes.pipe(Stream.map(() => checkout))
              ).pipe(Stream.mapEffect(() => Effect.map(page(checkout), (result) => result.entries)))
            );
          })
        );

      return {
        put,
        page,
        watch,
        subscribe: Effect.map(PubSub.subscribe(activity), Stream.fromSubscription),
        touch,
      };
    })
  );
}
