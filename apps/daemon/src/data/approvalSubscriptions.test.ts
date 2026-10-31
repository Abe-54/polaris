import { expect, test } from "bun:test";
import { ApprovalDecision, ApprovalRequest, DomainEvent, RequestId } from "@polaris/protocol";
import { Effect, Fiber, Layer, Stream } from "effect";
import { EventStore, LiveItem } from "../store/EventStore.ts";
import { DataApprovals } from "./approvals.ts";
import { seedDataSession, started } from "./approvals.testing.ts";
import { DataDatabase } from "./database.ts";

const requestId = RequestId.make("watched-data-approval");

const requested = (id: RequestId) =>
  DomainEvent.cases.ApprovalRequested.make({
    request: new ApprovalRequest({
      id,
      sessionId: started.session.id,
      turnId: started.turns[0]!.id,
      kind: "tool",
      title: "Read remote",
      detail: "",
      options: [],
      questions: [],
      openedAt: started.session.createdAt,
      dataSource: {
        sourceId: "remote",
        sourceName: "remote",
        engine: "postgres",
        host: "db.example",
        port: 5432,
        database: "app",
        user: "reader",
      },
    }),
  });

for (const waiting of [false, true])
  test(`approval projection${waiting ? " and waiter" : ""} skip unrelated live items`, () => {
    const reads = { model: 0, events: 0 };

    const counted = Layer.effect(
      EventStore,
      Effect.map(EventStore, (store) => ({
        ...store,
        model: Effect.tap(store.model, () => Effect.sync(() => reads.model++)),
        readEvents: (options) =>
          Effect.tap(store.readEvents(options), () => Effect.sync(() => reads.events++)),
      }))
    ).pipe(Layer.provide(EventStore.layerSqlite(":memory:")));

    const layer = DataApprovals.layer.pipe(
      Layer.provideMerge(DataDatabase.layerAt(":memory:")),
      Layer.provideMerge(counted)
    );

    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seedDataSession;
          const store = yield* EventStore;
          const approvals = yield* DataApprovals;
          yield* store.commit({
            commandId: null,
            decide: () => Effect.succeed([requested(requestId)]),
          });
          // A projected change is a barrier after the initial durable sync.
          yield* approvals.changes.pipe(Stream.runHead);

          const waiter = waiting
            ? yield* approvals.awaitApproval(requestId, 1000).pipe(Effect.forkScoped)
            : undefined;

          yield* Effect.sleep(10);
          const before = { ...reads };

          for (let n = 0; n < 64; n++) {
            yield* store.publishEphemeral(
              LiveItem.Delta({
                sessionId: started.session.id,
                turnId: started.turns[0]!.id,
                itemId: "streaming-message",
                field: "text",
                text: "delta",
                subagentId: null,
              })
            );
          }

          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.SessionRenamed.make({
                  sessionId: started.session.id,
                  title: "Unrelated change",
                }),
              ]),
          });
          yield* Effect.sleep(10);
          expect(reads).toEqual(before);

          yield* store.commit({
            commandId: null,
            decide: () => Effect.succeed([requested(RequestId.make("other-approval"))]),
          });
          yield* Effect.sleep(10);
          // Only the projection reads for another request; the waiter stays asleep.
          expect(reads.model - before.model).toBe(1);
          expect(reads.events - before.events).toBe(1);

          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.ApprovalResolved.make({
                  sessionId: started.session.id,
                  requestId,
                  decision: ApprovalDecision.cases.Allow.make({ remember: false }),
                  resolvedBy: "test",
                }),
              ]),
          });

          if (waiter) expect(yield* Fiber.join(waiter)).toEqual({ status: "approved" });
          expect(yield* approvals.awaitApproval(requestId, 10)).toEqual({ status: "approved" });
        })
      ).pipe(Effect.provide(layer))
    );
  });

test("initial sync replays approvals committed before the projection subscribed", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedDataSession;
        const store = yield* EventStore;
        yield* store.commit({
          commandId: null,
          decide: () => Effect.succeed([requested(requestId)]),
        });
        yield* Effect.gen(function* () {
          const approvals = yield* DataApprovals;
          expect(yield* approvals.awaitApproval(requestId, 1)).toEqual({ status: "pending" });
        }).pipe(Effect.provide(DataApprovals.layer));
      })
    ).pipe(
      Effect.provide(DataDatabase.layerAt(":memory:")),
      Effect.provide(EventStore.layerSqlite(":memory:"))
    )
  ));
