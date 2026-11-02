import { expect, test } from "bun:test";
import {
  Attempt,
  CommandId,
  DomainEvent,
  PlanOperation,
  RemoteDeliveryInput,
  RemoteDeliveryPacket,
  RemoteWorkerAssignment,
  ReviewAction,
  SessionId,
  TaskId,
  WorkerPlacement,
} from "@polaris/protocol";
import { Deferred, Effect, Predicate, Struct } from "effect";
import { B, C, CID, ctx, draft, report, task } from "../../engine/constellation.testing.ts";
import { decideConstellation } from "../../engine/constellation.ts";
import { EventStore } from "../../store/EventStore.ts";
import { Constellations } from "../service.ts";
import {
  ConstellationDelivery,
  ConstellationSessionEffects,
  applyWorkerDelivery,
} from "../delivery/index.ts";
import {
  finish,
  fakeWorkerAdmission,
  send,
  session,
  setup,
  signal,
  STANDALONE,
  wait,
  WORKER,
  world,
} from "../delivery/testing.ts";
import { fakeHost, connectFake } from "../transfers/fakeHost.testing.ts";
import { transferError } from "../worktrees.ts";
import { validateRemoteDelivery } from "./remoteDelivery.ts";
import { recordRemoteBlockTrace } from "./remoteBlocked.trace.testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const X = TaskId.make("X");

const SIBLING = SessionId.make("sibling");

const acceptFeed = Effect.fnUntraced(function* () {
  const store = yield* EventStore;
  const feed = draft(B, "feed", STANDALONE);
  const claim = report(feed.branch, "feed-head");

  for (const [command, context] of [
    [
      C.Dispatch.make({
        constellationId: CID,
        tasks: [
          { taskId: B, worker: WorkerPlacement.cases.Existing.make({ sessionId: STANDALONE }) },
        ],
      }),
      ctx({ attempts: [feed] }),
    ],
    [
      C.WorkerClaim.make({ constellationId: CID, attemptId: feed.id, claim }),
      ctx({
        binding: { kind: "session", sessionId: STANDALONE },
        claimProbe: { branch: feed.branch, head: claim.head, dirtyPaths: [] },
      }),
    ],
    [
      C.Review.make({
        constellationId: CID,
        attemptId: feed.id,
        revision: 1,
        action: ReviewAction.cases.Accept.make({ mergedHead: claim.head, receipts: [] }),
      }),
      ctx(),
    ],
  ] satisfies ReadonlyArray<
    readonly [import("@polaris/protocol").ConstellationCommand, ReturnType<typeof ctx>]
  >)
    yield* store.commit({
      commandId: CommandId.make(crypto.randomUUID()),
      decide: (model) => {
        const result = decideConstellation(model.constellations.get(CID), command, context);
        expect(result.rejection).toBeNull();

        return Effect.succeed(result.events);
      },
    });
});

test("real delivery RPC queues a blocked Session while another Session proceeds on the same Host", async () => {
  const root = newTempDir("block-cycles-rpc-", { short: true });

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const arrived = yield* Deferred.make<void>();
          const turns: string[] = [];

          const effects = ConstellationSessionEffects.of({
            canSteer: () => Effect.succeed(true),
            runTurn: (turn) =>
              Effect.gen(function* () {
                turns.push(turn.sessionId);
                yield* signal(turn.sessionId, { type: "harness.opened" }).pipe(
                  Effect.provideService(EventStore, worker.store),
                  Effect.orDie
                );
              }),
            steer: () => Effect.void,
            interrupt: () => Effect.void,
            retire: () => Effect.void,
          });

          const worker: Effect.Success<ReturnType<typeof fakeHost>> = yield* fakeHost(root, {
            delivery: {
              apply: (packet) =>
                applyWorkerDelivery(packet, (p, model) =>
                  Effect.gen(function* () {
                    yield* validateRemoteDelivery(
                      p,
                      model,
                      yield* worker.storage.assignments.pipe(Effect.orDie)
                    );

                    if (Predicate.isTagged(p.input, "Turn") && p.input.cause === "unblock")
                      yield* Deferred.succeed(arrived, undefined);
                  })
                ).pipe(
                  Effect.provideService(EventStore, worker.store),
                  Effect.provideService(ConstellationSessionEffects, effects),
                  Effect.mapError((error) => transferError("E-DELIVERY", error.message))
                ),
            },
          });

          yield* worker.store.commit({
            commandId: CommandId.make("sessions"),
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.SessionCreated.make({ session: session(WORKER) }),
                DomainEvent.cases.SessionCreated.make({ session: session(SIBLING) }),
              ]),
          });

          for (const id of [WORKER, SIBLING]) yield* fakeWorkerAdmission(worker.store, id);

          yield* send(WORKER).pipe(Effect.provideService(EventStore, worker.store));
          const rpc = yield* connectFake(worker.server.socketPath);

          let unblockPacket: RemoteDeliveryPacket | undefined;

          const owner = world(":memory:", {
            attempt: Attempt.make(Struct.assign(draft(), { hostId: worker.host.hostId })),
            remoteSend: (packet) =>
              rpc.client["constellation.delivery.apply"]({ packet }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    unblockPacket = packet;
                  })
                ),
                Effect.asVoid,
                Effect.orDie
              ),
          });

          yield* Effect.promise(() =>
            owner.run(
              Effect.gen(function* () {
                yield* setup();
                const graphs = yield* Constellations;
                const store = yield* EventStore;
                const delivery = yield* ConstellationDelivery;
                yield* graphs.command(
                  { kind: "user" },
                  CommandId.make("feeds"),
                  C.Plan.make({
                    constellationId: CID,
                    operations: [B, X].map((id) =>
                      PlanOperation.cases.Add.make({ task: task(id) })
                    ),
                  })
                );

                const sibling = Attempt.make(
                  Struct.assign(draft(X, "sibling", SIBLING), { hostId: worker.host.hostId })
                );

                yield* store.commit({
                  commandId: CommandId.make("sibling"),
                  decide: (model) => {
                    const result = decideConstellation(
                      model.constellations.get(CID),
                      C.Dispatch.make({
                        constellationId: CID,
                        tasks: [
                          {
                            taskId: X,
                            worker: WorkerPlacement.cases.Existing.make({ sessionId: SIBLING }),
                          },
                        ],
                      }),
                      ctx({ attempts: [sibling] })
                    );

                    expect(result.rejection).toBeNull();

                    return Effect.succeed(result.events);
                  },
                });
                yield* graphs.command(
                  { kind: "session", sessionId: WORKER },
                  CommandId.make("block"),
                  C.WorkerBlock.make({
                    constellationId: CID,
                    attemptId: draft().id,
                    on: [B],
                    reason: "Wait",
                  })
                );
                const graph = (yield* store.model).constellations.get(CID)!.graph;

                for (const attempt of [graph.attempts[0]!, sibling])
                  yield* worker.storage.assign(
                    RemoteWorkerAssignment.make({ graph, attemptId: attempt.id, repoPath: "/tmp" })
                  );
                yield* delivery.start();
                yield* acceptFeed();
                yield* Deferred.await(arrived);
                expect(turns).toEqual([]);
                expect((yield* store.model).constellations.get(CID)!.graph.attempts[0]!.state).toBe(
                  "blocked"
                );

                const packet = RemoteDeliveryPacket.make({
                  id: "sibling-input",
                  ownerHostId: graph.hostId,
                  workerHostId: worker.host.hostId,
                  constellationId: CID,
                  attemptId: sibling.id,
                  sessionId: SIBLING,
                  input: RemoteDeliveryInput.cases.Turn.make({
                    text: "Continue sibling",
                    cause: "message",
                  }),
                });

                yield* rpc.client["constellation.delivery.apply"]({ packet }).pipe(
                  Effect.timeout(2000)
                );
                expect(turns).toEqual([SIBLING]);
                const before = (yield* store.model).sequence;
                yield* finish(WORKER).pipe(Effect.provideService(EventStore, worker.store));
                yield* wait(() =>
                  Effect.map(
                    store.model,
                    (m) => m.constellations.get(CID)!.graph.attempts[0]!.state === "working"
                  )
                );
                expect(turns).toEqual([SIBLING, WORKER]);

                const events = yield* store.readConstellationEvents({
                  constellationId: CID,
                  after: before,
                  upTo: (yield* store.model).sequence,
                });

                expect(events.map((e) => e.event._tag)).toEqual([
                  "AttemptUnblocked",
                  "WorkerInputDelivered",
                ]);
                const delivered = yield* worker.storage.get("delivered", packet.id);
                expect(delivered).not.toBeNull();
                yield* rpc.client["constellation.delivery.apply"]({ packet });
                yield* rpc.client["constellation.delivery.apply"]({ packet: unblockPacket! });
                expect(
                  yield* rpc.client["constellation.delivery.apply"]({
                    packet: RemoteDeliveryPacket.make(
                      Struct.assign(unblockPacket!, { attemptId: sibling.id, sessionId: SIBLING })
                    ),
                  }).pipe(Effect.flip)
                ).toMatchObject({ code: "E-IDEMPOTENCY" });
                yield* delivery.flush();
                expect(turns).toEqual([SIBLING, WORKER]);
                yield* recordRemoteBlockTrace(store, worker.store, worker.host.hostId);
              })
            )
          );
        })
      )
    );
  } finally {
    removeTempDir(root);
  }
}, 15_000);
