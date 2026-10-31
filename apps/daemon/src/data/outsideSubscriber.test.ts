import { expect, test } from "bun:test";
import { DomainEvent, SessionId, TurnId, TurnItem } from "@polaris/protocol";
import { Deferred, Effect, Layer, Redacted } from "effect";
import { EventStore, StoreConfig } from "../store/EventStore.ts";
import { source } from "../mcp/tools/data.testing.ts";
import { watchOutsideCommands } from "./outsideSubscriber.ts";

const sessionId = SessionId.make("outside-session");

const event = (id: string) =>
  DomainEvent.cases.TurnItemCompleted.make({
    sessionId,
    turnId: TurnId.make("turn"),
    subagentId: null,
    item: TurnItem.cases.CommandExecution.make({
      id,
      startedAt: null,
      command: 'psql "$DATABASE_URL"',
      cwd: "/tmp",
      output: "",
      exitCode: 0,
      status: "completed",
    }),
  });

test("RM F13: overflow resubscribes and records subsequent commands", async () => {
  const recorded = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const first = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const ids: string[] = [];
        let paused = false;
        yield* watchOutsideCommands(
          store,
          {
            list: () => Effect.succeed([source]),
            resolve: () =>
              Effect.gen(function* () {
                if (!paused) {
                  paused = true;
                  yield* Deferred.succeed(first, undefined);
                  yield* Deferred.await(release);
                }

                return {
                  source,
                  matchUrl: Redacted.make("postgres://owner:pw@localhost/ledger"),
                  connection: {
                    hostname: "localhost",
                    port: 5432,
                    database: "ledger",
                    username: "owner",
                    password: Redacted.make("private"),
                    tls: false,
                  },
                };
              }),
          },
          {
            recordOutside: (input) =>
              Effect.sync(() => {
                ids.push(input.itemId);
              }),
          }
        ).pipe(Effect.forkScoped);

        while ((yield* store.subscriberCount) === 0) yield* Effect.yieldNow;

        const publish = (id: string) =>
          store.commit({ commandId: null, decide: () => Effect.succeed([event(id)]) });

        yield* publish("first");
        yield* Deferred.await(first);
        yield* publish("queued");
        yield* publish("overflow");
        expect(yield* store.subscriberCount).toBe(0);
        yield* Deferred.succeed(release, undefined);

        while ((yield* store.subscriberCount) === 0) yield* Effect.yieldNow;
        yield* publish("after-overflow");

        while (!ids.includes("after-overflow")) yield* Effect.yieldNow;

        return ids;
      })
    ).pipe(
      Effect.provide(
        EventStore.layerSqlite(":memory:").pipe(
          Layer.provide(Layer.succeed(StoreConfig)({ subscriberCapacity: 1 }))
        )
      )
    )
  );

  expect(recorded).toContain("after-overflow");
}, 5000);
