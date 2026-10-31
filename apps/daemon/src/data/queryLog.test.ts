import { expect, test } from "bun:test";
import { QueryLogEntry } from "@polaris/protocol";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { QueryLog } from "./queryLog.ts";
import { DataDatabase } from "./database.ts";
import { DataApprovals } from "./approvals.ts";
import { EventStore } from "../store/EventStore.ts";

const layer = () =>
  QueryLog.layer.pipe(
    Layer.provide(DataApprovals.layer),
    Layer.provide(DataDatabase.layerAt(":memory:")),
    Layer.provide(EventStore.layerSqlite(":memory:"))
  );

const entry = (id: number, checkout = "/repo") =>
  new QueryLogEntry({
    id: `q${id}`,
    checkout,
    source: { id: "s", name: "app" },
    sql: `SELECT ${id}`,
    state: "completed",
    author: { kind: "user" },
    at: new Date().toISOString(),
  });

test(
  "Query Log retains the newest 10000 per Host and pages exclusively by id",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* QueryLog;

        for (let i = 0; i < 10003; i++) yield* log.put(entry(i));
        yield* log.put(entry(11000, "/other"));
        const page = yield* log.page("/repo");
        expect(page.entries).toHaveLength(100);
        expect(page.entries[0]!.id).toBe("q10002");
        const next = yield* log.page("/repo", page.next!, 100);
        expect(next.entries[0]!.id).toBe("q9902");
        const tail = yield* log.page("/repo", "q5");
        expect(tail.entries.map((row) => row.id)).toEqual(["q4"]);
        expect((yield* log.page("/other")).entries.map((row) => row.id)).toEqual(["q11000"]);
      }).pipe(Effect.provide(layer()))
    ),
  30000
);

test("outside item replay is idempotent and watch delivers persisted changes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const log = yield* QueryLog;
        yield* log.put(entry(1), true);
        yield* log.put(
          new QueryLogEntry({
            ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry(1)),
            sql: "changed replay",
          }),
          true
        );
        expect((yield* log.page("/repo")).entries[0]!.sql).toBe("SELECT 1");
        const ready = yield* Deferred.make<void>();

        const watching = yield* log.watch("/repo").pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped
        );

        yield* Deferred.await(ready);
        yield* log.put(entry(2));
        const snapshots = yield* Fiber.join(watching);
        expect(snapshots.map((rows) => rows.map((row) => row.id))).toEqual([["q1"], ["q2", "q1"]]);
      })
    ).pipe(Effect.provide(layer()))
  ));
