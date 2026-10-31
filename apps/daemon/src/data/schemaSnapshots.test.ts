import { expect, test } from "bun:test";
import {
  DataSource,
  DomainEvent,
  QueryLogEntry,
  SchemaSourceDiff,
  SessionId,
} from "@polaris/protocol";
import { Deferred, Effect, Fiber, Schema } from "effect";
import {
  catalog,
  entry,
  fixture,
  nextTurn,
  snapshotLayer,
  source,
  turn,
} from "./schemaSnapshots.testing.ts";

const run = (
  work: Effect.Effect<
    void,
    unknown,
    | import("effect").Scope.Scope
    | import("./queryLog.ts").QueryLog
    | import("./database.ts").DataDatabase
    | import("../store/EventStore.ts").EventStore
  >
) => Effect.runPromise(Effect.scoped(work).pipe(Effect.provide(snapshotLayer())));

test("migration-only Turn snapshots persist a rename and whole-session span", () =>
  run(
    Effect.gen(function* () {
      let name = "invoices";
      const f = yield* fixture({ capture: () => Effect.sync(() => catalog(name)) });
      yield* f.worker.begin(turn);
      name = "bills";
      yield* f.worker.end(turn);
      const diff = yield* f.worker.get({ sessionId: turn.sessionId, turn: turn.id });
      expect(diff.sources[0]).toMatchObject({
        baseline: "turn-start",
        status: "complete",
        tables: [{ kind: "renamed", before: { name: "invoices" }, after: { name: "bills" } }],
      });
      expect(Schema.is(SchemaSourceDiff)(diff.sources[0])).toBe(true);
      expect((yield* f.worker.get({ sessionId: turn.sessionId })).sources).toEqual(diff.sources);
      yield* f.worker.remove(turn.sessionId);
      expect((yield* f.worker.get({ sessionId: turn.sessionId })).sources).toEqual([]);
    })
  ));

test("no sources or migration path causes no catalog I/O, and unused candidates stay out of Review", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture({ migrationChanged: () => Promise.resolve(false) });
      f.empty();
      yield* f.worker.begin(turn);
      expect(f.reads()).toBe(0);
      f.source(source);
      yield* f.worker.begin(turn);
      yield* f.worker.end(turn);
      expect(f.reads()).toBe(1);
      expect((yield* f.worker.get({ sessionId: turn.sessionId })).sources).toEqual([]);
      const noMigration = yield* fixture({ migrationCheckout: () => Promise.resolve(false) });
      yield* noMigration.worker.begin(turn);
      expect(noMigration.reads()).toBe(0);
    })
  ));

test("remote baseline never reads or asks; existing approval admits first use only", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();

      const remote = (access: DataSource["access"]) =>
        new DataSource({
          ...Schema.decodeUnknownSync(Schema.Struct(DataSource.fields))(source),
          locality: "remote",
          access,
        });

      f.source(remote("needs-approval"));
      yield* f.worker.begin(turn);
      expect(f.reads()).toBe(0);
      yield* f.worker.touch(entry());
      expect(f.reads()).toBe(0);
      f.source(remote("approved"));
      yield* f.worker.touch(entry());
      expect(f.reads()).toBe(1);
      yield* f.worker.end(turn);
      expect(f.reads()).toBe(2);
      expect((yield* f.worker.get({ sessionId: turn.sessionId })).sources[0]).toMatchObject({
        baseline: "first-use",
        status: "complete",
      });
      const record = (yield* f.store.model).sessions.get(turn.sessionId)!;
      expect(record.pending.size).toBe(0);
    })
  ));

test("previous end baseline is labelled, and another session's checkout activity makes it stale", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.worker.begin(turn);
      yield* f.worker.end(turn);
      expect(f.reads()).toBe(2);
      yield* f.worker.begin(nextTurn);
      expect(f.reads()).toBe(2);
      expect(f.records.records(turn.sessionId, nextTurn.id)[0]?.baseline).toBe("previous-turn-end");
      f.records.remove(turn.sessionId);
      yield* f.worker.begin(turn);
      yield* f.worker.end(turn);
      yield* f.log.put(
        new QueryLogEntry({
          ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry()),
          id: "other",
          at: "2020-01-01T00:00:00Z",
          author: { kind: "agent", sessionId: SessionId.make("other"), turn: turn.id },
        })
      );
      const reads = f.reads();
      yield* f.worker.begin(nextTurn);
      expect(f.reads()).toBe(reads + 1);
      expect(f.records.records(turn.sessionId, nextTurn.id)[0]?.baseline).toBe("first-use");
    })
  ));

test("committing TurnEnded does not wait for a blocked catalog and archive prevents late resurrection", () =>
  run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const f = yield* fixture({
        capture: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);

            return catalog();
          }),
      });

      const running = yield* f.worker.begin(turn).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);

      const result = yield* f.store.commit({
        commandId: null,
        decide: () => Effect.succeed([DomainEvent.cases.TurnEnded.make({ turn })]),
      });

      expect(result._tag).toBe("Committed");
      yield* f.store.commit({
        commandId: null,
        decide: () =>
          Effect.succeed([
            DomainEvent.cases.SessionStateChanged.make({
              sessionId: turn.sessionId,
              state: "archived",
              reason: null,
            }),
          ]),
      });
      yield* f.worker.remove(turn.sessionId);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      expect(f.records.records(turn.sessionId)).toEqual([]);
    })
  ));

test("the live committed-event subscription captures outside the commit boundary", () =>
  run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const f = yield* fixture({
        capture: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);

            return catalog();
          }),
      });

      const result = yield* f.store.commit({
        commandId: null,
        decide: () => Effect.succeed([DomainEvent.cases.TurnStarted.make({ turn: nextTurn })]),
      });

      expect(result._tag).toBe("Committed");
      yield* Deferred.await(entered);
      expect(f.records.records(turn.sessionId, nextTurn.id)[0]?.before).toBeNull();

      const ended = yield* f.store.commit({
        commandId: null,
        decide: () => Effect.succeed([DomainEvent.cases.TurnEnded.make({ turn: nextTurn })]),
      });

      expect(ended._tag).toBe("Committed");
      yield* Deferred.succeed(release, undefined);
    })
  ));

test("Turn-end capture retains W affected counts after Query Log pruning", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture({ migrationChanged: () => Promise.resolve(false) });
      yield* f.worker.begin(turn);

      const logged = {
        ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry("completed")),
        affected: [{ schema: "public", table: "invoices", rows: 7 }],
      };

      f.db
        .query("INSERT INTO data_query_log(id,checkout,value) VALUES (?,?,?)")
        .run("write", logged.checkout, JSON.stringify(logged));
      yield* f.worker.end(turn);
      f.db.query("DELETE FROM data_query_log").run();
      expect(
        (yield* f.worker.get({ sessionId: turn.sessionId, turn: turn.id })).sources[0]?.tables[0]
          ?.rows
      ).toEqual({ kind: "exact", value: 7, agent: 7, user: 0 });
    })
  ));
