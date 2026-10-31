import { expect, test } from "bun:test";
import {
  AgentSession,
  DomainEvent,
  DataError,
  DataSource,
  QueryLogEntry,
  SessionId,
  Turn,
  TurnId,
} from "@polaris/protocol";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { targetKey, targetOf } from "./approvalStore.ts";
import {
  catalog,
  entry,
  fixture,
  nextTurn,
  snapshotLayer,
  source,
  turn,
} from "./schemaSnapshots.testing.ts";

type Environment =
  | import("effect").Scope.Scope
  | import("./queryLog.ts").QueryLog
  | import("./database.ts").DataDatabase
  | import("../store/EventStore.ts").EventStore;

const run = (effect: Effect.Effect<void, unknown, Environment>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(snapshotLayer())));

const turnFields = Schema.decodeUnknownSync(Schema.Struct(Turn.fields));

const fields = Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields));

const target = targetKey(targetOf(source));

test("unused Turns carry original provenance without another capture; only an actual adjacent end uses previous-turn-end", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture({ migrationChanged: () => Promise.resolve(false) });
      yield* f.worker.begin(turn);
      yield* f.worker.end(turn);
      yield* f.worker.begin(nextTurn);
      yield* f.worker.end(nextTurn);
      expect(f.reads()).toBe(1);
      const carried = f.records.records(turn.sessionId, nextTurn.id)[0]!;
      expect(carried).toMatchObject({ baseline: "first-use", baselineTurn: turn.id });
      expect(carried.before?.at).toBe(f.records.records(turn.sessionId, turn.id)[0]?.before?.at);
      f.records.put({ ...carried, used: true });
      yield* f.worker.end(nextTurn);

      const third = new Turn({
        ...turnFields(nextTurn),
        id: TurnId.make("third"),
        index: nextTurn.index + 1,
      });

      yield* f.worker.begin(third);
      expect(f.records.records(turn.sessionId, third.id)[0]).toMatchObject({
        baseline: "previous-turn-end",
        baselineTurn: nextTurn.id,
      });
    })
  ));

test("same-target activity in another checkout or the same session's user invalidates a baseline", () =>
  run(
    Effect.gen(function* () {
      for (const author of [
        { kind: "agent" as const, sessionId: SessionId.make("other"), turn: turn.id },
        { kind: "user" as const, sessionId: turn.sessionId },
      ]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.worker.begin(turn);
            yield* f.worker.end(turn);
            yield* f.log.put(
              new QueryLogEntry({
                ...fields(entry()),
                id: crypto.randomUUID(),
                target,
                checkout: "/different-checkout",
                author,
              })
            );
            const before = f.reads();
            yield* f.worker.begin(nextTurn);
            expect(f.reads()).toBe(before + 1);
            expect(f.records.records(turn.sessionId, nextTurn.id)[0]?.baseline).toBe("first-use");
            yield* f.worker.remove(turn.sessionId);
          })
        );
      }
    })
  ));

test("other-target activity cannot invalidate or contaminate a reused baseline", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.worker.begin(turn);
      yield* f.worker.end(turn);
      yield* f.log.put(
        new QueryLogEntry({
          ...fields(entry()),
          id: "other-target",
          target: "different",
          author: { kind: "user", sessionId: turn.sessionId },
        })
      );
      const before = f.reads();
      yield* f.worker.begin(nextTurn);
      expect(f.reads()).toBe(before);
    })
  ));

test("known push commands compare at end without Data use or migration files, once per Turn", () =>
  run(
    Effect.gen(function* () {
      for (const command of [
        "bunx prisma db push",
        "npx drizzle-kit push",
        "docker compose exec db psql -c 'create table payouts(id int)'",
      ]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            let name = "invoices";
            let reads = 0;

            const f = yield* fixture({
              capture: () =>
                Effect.sync(() => {
                  reads++;

                  return catalog(name);
                }),
              migrationChanged: () => Promise.resolve(false),
            });

            yield* f.worker.begin(turn);
            name = "payouts";
            yield* f.worker.outside(turn.sessionId, turn.id, command);
            yield* f.worker.outside(turn.sessionId, turn.id, command);
            yield* f.worker.end(turn);
            expect(reads).toBe(2);
            expect(
              (yield* f.worker.get({ sessionId: turn.sessionId, turn: turn.id })).sources[0]
                ?.tables[0]?.after?.name
            ).toBe("payouts");
            yield* f.worker.remove(turn.sessionId);
          })
        );
      }
    })
  ));

test("late captures expose actual timing and preserve real failure codes", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.worker.begin(turn);
      yield* f.worker.end(turn);
      expect(
        (yield* f.worker.get({ sessionId: turn.sessionId, turn: turn.id })).sources[0]
      ).toMatchObject({ capturedLate: true, baselineTurn: turn.id });
      yield* f.worker.remove(turn.sessionId);

      for (const code of ["E-DATA-DENIED", "E-DATA-UNREACHABLE", "E-DATA-SQL"] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const failed = yield* fixture({
              capture: () =>
                Effect.fail(new DataError({ code, message: "Unavailable", fix: "Retry" })),
            });

            yield* failed.worker.begin(turn);
            yield* failed.worker.end(turn);
            expect(
              (yield* failed.worker.get({ sessionId: turn.sessionId, turn: turn.id })).sources[0]
            ).toMatchObject({ status: "unavailable", errorCode: code });
            yield* failed.worker.remove(turn.sessionId);
          })
        );
      }
    })
  ));

test("shared-target activity during a Turn is flagged and cannot make counted writes exact", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture({ migrationChanged: () => Promise.resolve(false) });
      yield* f.worker.begin(turn);
      f.records.activity(target, "other-session", "other-turn");
      f.db.query("INSERT INTO data_query_log(id,checkout,value) VALUES (?,?,?)").run(
        "counted",
        "/repo",
        JSON.stringify({
          ...fields(entry("completed")),
          affected: [{ schema: "public", table: "invoices", rows: 5 }],
        })
      );
      yield* f.worker.end(turn);
      const diff = (yield* f.worker.get({ sessionId: turn.sessionId, turn: turn.id })).sources[0]!;
      expect(diff.concurrent).toBe(true);
      expect(diff.tables[0]?.rows).toEqual({ kind: "unknown", value: null, agent: 5, user: 0 });
    })
  ));

test("a write waits for first-use baseline capture before its statement runs", () =>
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

      let written = false;

      const write = yield* f.log.beforeWrite(entry()).pipe(
        Effect.andThen(
          Effect.sync(() => {
            written = true;
          })
        ),
        Effect.forkScoped
      );

      yield* Deferred.await(entered).pipe(Effect.timeout(3000));
      expect(written).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(write);
      expect(written).toBe(true);
      expect(f.records.records(turn.sessionId, turn.id)[0]?.before?.tables[0]?.name).toBe(
        "invoices"
      );
    })
  ));

test("sessions never share a cached catalog baseline after the target changed", () =>
  run(
    Effect.gen(function* () {
      let name = "before";
      const f = yield* fixture({ capture: () => Effect.sync(() => catalog(name)) });
      const existing = (yield* f.store.model).sessions.get(turn.sessionId)!.session;
      const otherId = SessionId.make("second-session");
      yield* f.store.commit({
        commandId: null,
        decide: () =>
          Effect.succeed([
            DomainEvent.cases.SessionCreated.make({
              session: new AgentSession({
                ...Schema.decodeUnknownSync(Schema.Struct(AgentSession.fields))(existing),
                id: otherId,
                cwd: "/other",
              }),
            }),
          ]),
      });
      yield* f.worker.begin(turn);
      name = "after";

      const other = new Turn({
        ...turnFields(turn),
        sessionId: otherId,
        id: TurnId.make("other-turn"),
      });

      yield* f.worker.begin(other);
      expect(f.records.records(otherId, other.id)[0]?.before?.tables[0]?.name).toBe("after");
    })
  ));

test("a blocked target does not delay another target's committed Turn-start capture", () =>
  run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const otherEntered = yield* Deferred.make<void>();

      const f = yield* fixture({
        capture: (resolved) =>
          Effect.gen(function* () {
            if (resolved.source.database === "app") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            } else yield* Deferred.succeed(otherEntered, undefined);

            return catalog();
          }),
      });

      const existing = (yield* f.store.model).sessions.get(turn.sessionId)!.session;
      const otherId = SessionId.make("parallel-session");

      const other = new Turn({
        ...turnFields(turn),
        sessionId: otherId,
        id: TurnId.make("parallel-turn"),
      });

      yield* f.store.commit({
        commandId: null,
        decide: () =>
          Effect.succeed([
            DomainEvent.cases.SessionCreated.make({
              session: new AgentSession({
                ...Schema.decodeUnknownSync(Schema.Struct(AgentSession.fields))(existing),
                id: otherId,
                cwd: "/parallel",
              }),
            }),
            DomainEvent.cases.TurnStarted.make({ turn }),
          ]),
      });
      yield* Deferred.await(entered).pipe(Effect.timeout(3000));
      f.source(new DataSource({ ...Schema.encodeSync(DataSource)(source), database: "other" }));
      yield* f.store.commit({
        commandId: null,
        decide: () => Effect.succeed([DomainEvent.cases.TurnStarted.make({ turn: other })]),
      });
      yield* Deferred.await(otherEntered).pipe(Effect.timeout(3000));
      yield* f.worker.begin(other);
      expect(f.records.records(otherId, other.id)[0]?.capturedLate).toBe(true);
      yield* Deferred.succeed(release, undefined);
    })
  ));
