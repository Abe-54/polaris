import { expect, test } from "bun:test";
import {
  CommandId,
  DomainEvent,
  MessageTarget,
  PlanOperation,
  ReviewAction,
  TurnTrigger,
  TurnId,
  WorkerPlacement,
} from "@polaris/protocol";
import { Effect, Layer, Predicate } from "effect";
import { A, B, C, CID, ctx, draft, report, task } from "../../engine/constellation.testing.ts";
import { decideConstellation } from "../../engine/constellation.ts";
import { withSessionInput } from "../../engine/sessionBoundary.ts";
import { recordSendbackTrace } from "../../mcp/sendback.trace.testing.ts";
import { recordResourceTrace } from "../../resources/trace.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { HostResources } from "../../resources/index.ts";
import { ConstellationRuntime } from "../runtime.ts";
import { workingAttemptsLayer } from "../working.ts";
import { ConstellationDelivery } from "./index.ts";
import { finish, send, setup, signal, STANDALONE, wait, WORKER, world } from "./testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const resourceCounts = (store: EventStore["Service"]) =>
  Effect.map(store.model, (model) => ({
    workerCap: {
      working: [...(model.hostResources?.leases.values() ?? [])].filter(
        (l) => l.resource === "__workers"
      ).length,
      waiting: [...(model.hostResources?.waiting.values() ?? [])].filter(
        (l) => l.resource === "__workers"
      ).length,
    },
  }));

const id = () => CommandId.make(crypto.randomUUID());

const runtime = (starts: string[]) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* EventStore;
      const resources = yield* HostResources;
      yield* resources.setWorkerCap(id(), 1);

      return workingAttemptsLayer({
        runtime: {
          prepare: () =>
            Effect.succeed({
              attempts: [draft()],
              newLeadSessionId: null,
              claimProbe: null,
              recordedChecks: [],
            }),
          resumeWorking: () => Effect.void,
          afterCommit: () => Effect.void,
        },
        acquireWorker: resources.acquireWorker,
        startWorker: (attempt) =>
          send(attempt.sessionId).pipe(
            Effect.provideService(EventStore, store),
            Effect.orDie,
            Effect.andThen(Effect.sync(() => starts.push(attempt.taskId))),
            Effect.asVoid
          ),
        resumeWorker: () => Effect.void,
        failed: () => Effect.die("Unexpected startup failure"),
      });
    })
  ).pipe(Layer.provide(HostResources.layer), Layer.orDie);

const commit = (command: import("@polaris/protocol").ConstellationCommand, context = ctx()) =>
  Effect.gen(function* () {
    const store = yield* EventStore;

    const result = yield* store.commit({
      commandId: id(),
      decide: (model) => {
        const decision = decideConstellation(model.constellations.get(CID), command, context);
        expect(decision.rejection).toBeNull();

        return Effect.succeed(decision.events);
      },
    });

    if (Predicate.isTagged(result, "Committed"))
      yield* (yield* ConstellationRuntime).afterCommit({ kind: "user" }, command, result.envelopes);
  });

const block = (on: (typeof A)[] = []) =>
  commit(
    C.WorkerBlock.make({ constellationId: CID, attemptId: draft().id, on, reason: "Wait" }),
    ctx({ binding: { kind: "session", sessionId: WORKER } })
  );

const leadMessage = () =>
  commit(
    C.Message.make({
      constellationId: CID,
      target: MessageTarget.cases.Worker.make({ attemptId: draft().id }),
      text: "Continue A",
    })
  );

const fixture = async (body: (root: string) => Promise<void>) => {
  const root = newTempDir("blocked-slots-test-", { short: true });
  const previous = process.env.POLARIS_HOME;
  process.env.POLARIS_HOME = root;

  try {
    await body(root);
  } finally {
    if (previous === undefined) delete process.env.POLARIS_HOME;
    else process.env.POLARIS_HOME = previous;
    removeTempDir(root);
  }
};

for (const cause of ["Lead", "Accepted"] as const)
  test(`capacity one: blocked A admits B, ${cause} resumes A once behind admission`, () =>
    fixture(async () => {
      const starts: string[] = [];

      const w = world(":memory:", {
        runtime: runtime(starts),
        onRun: () =>
          Effect.gen(function* () {
            const store = yield* EventStore;
            expect((yield* resourceCounts(store)).workerCap.working).toBe(1);
          }),
      });

      await w.run(
        Effect.gen(function* () {
          yield* setup();
          const store = yield* EventStore;
          const resources = { get: resourceCounts(store) };
          const delivery = yield* ConstellationDelivery;
          yield* wait(() => Effect.succeed(starts.length === 1));
          yield* commit(
            C.Plan.make({
              constellationId: CID,
              operations: [PlanOperation.cases.Add.make({ task: task(B) })],
            })
          );
          const b = draft(B, "b", STANDALONE);
          yield* commit(C.Dispatch.make({ constellationId: CID }), ctx({ attempts: [b] }));
          yield* wait(() => Effect.map(resources.get, (s) => s.workerCap.waiting === 1));
          yield* block(cause === "Accepted" ? [B] : []);
          expect(starts).toEqual([A]);
          expect((yield* resources.get).workerCap.working).toBe(1);
          // Background work retains the slot even after the foreground Turn ends.
          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.SessionBackgroundTasksChanged.make({
                  sessionId: WORKER,
                  tasks: [{ id: "child", kind: "subagent", description: "Still working" }],
                }),
              ]),
          });
          yield* finish(WORKER);
          yield* Effect.promise(() => Bun.sleep(20));
          expect(starts).toEqual([A]);
          // An earlier report must retain the next live child's reporting reservation.
          yield* signal(WORKER, {
            type: "harness.turnStarted",
            turnId: TurnId.make("earlier-report"),
            prompt: "",
            trigger: TurnTrigger.cases.BackgroundTasksReported.make({
              tasks: [{ id: "earlier-child", kind: "subagent" }],
            }),
            at: new Date().toISOString(),
          });
          yield* finish(WORKER);
          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.SessionBackgroundTasksChanged.make({
                  sessionId: WORKER,
                  tasks: [],
                }),
              ]),
          });
          yield* Effect.promise(() => Bun.sleep(20));
          expect(starts).toEqual([A]);
          yield* signal(WORKER, {
            type: "harness.turnStarted",
            turnId: TurnId.make("reported"),
            prompt: "",
            trigger: TurnTrigger.cases.BackgroundTasksReported.make({
              tasks: [{ id: "child", kind: "subagent" }],
            }),
            at: new Date().toISOString(),
          });
          yield* finish(WORKER);
          yield* wait(() => Effect.succeed(starts.length === 2));
          expect(starts).toEqual([A, B]);
          yield* delivery.start();

          if (cause === "Lead") {
            yield* leadMessage();
            yield* delivery.flush();
            yield* wait(() => Effect.map(resources.get, (s) => s.workerCap.waiting === 1));

            const steerProbe = yield* withSessionInput(
              store,
              WORKER,
              Effect.succeed("steer gate free")
            ).pipe(Effect.timeout(200));

            expect(steerProbe).toBe("steer gate free");
            expect(w.turns).toHaveLength(0);
            expect((yield* store.model).constellations.get(CID)!.graph.attempts[0]!.state).toBe(
              "blocked"
            );
          }

          const claim = report(b.branch, "b-head");
          yield* commit(
            C.WorkerClaim.make({ constellationId: CID, attemptId: b.id, claim }),
            ctx({
              binding: { kind: "session", sessionId: STANDALONE },
              claimProbe: { branch: b.branch, head: claim.head, dirtyPaths: [] },
            })
          );

          if (cause === "Accepted")
            yield* commit(
              C.Review.make({
                constellationId: CID,
                attemptId: b.id,
                revision: 1,
                action: ReviewAction.cases.Accept.make({ mergedHead: claim.head, receipts: [] }),
              })
            );
          yield* delivery.flush();
          yield* wait(() => Effect.succeed(w.turns.length === 1));
          yield* delivery.flush();
          expect(w.turns).toHaveLength(1);
          expect((yield* resources.get).workerCap).toMatchObject({ working: 1, waiting: 0 });

          const events = yield* store.readEvents({
            after: 0,
            upTo: (yield* store.model).sequence,
            sessionId: null,
          });

          const graphEvents = yield* store.readConstellationEvents({
            constellationId: CID,
            after: 0,
            upTo: (yield* store.model).sequence,
          });

          const unblock = graphEvents.filter((e) =>
            Predicate.isTagged(e.event, "AttemptUnblocked")
          );

          expect(unblock).toHaveLength(1);
          expect(unblock[0]!.event).toMatchObject({ cause });

          const resumeLease = events.findLast(
            (e) =>
              Predicate.isTagged(e.event, "ResourceLeased") && e.event.lease.sessionId === WORKER
          );

          expect(resumeLease!.event).toMatchObject({ lease: { attemptId: draft().id } });
          expect(resumeLease!.sequence).toBeLessThan(unblock[0]!.sequence);
          yield* recordSendbackTrace(`blocked-slots-${cause}`);
          yield* recordResourceTrace;
        })
      );
    }));

test("an inline background report in a trigger-null Turn releases capacity when the worker blocks", () =>
  fixture(async () => {
    const starts: string[] = [];
    await world(":memory:", { runtime: runtime(starts) }).run(
      Effect.gen(function* () {
        yield* setup();
        const store = yield* EventStore;
        yield* wait(() => Effect.succeed(starts.length === 1));
        yield* commit(
          C.Plan.make({
            constellationId: CID,
            operations: [PlanOperation.cases.Add.make({ task: task(B) })],
          })
        );
        yield* commit(
          C.Dispatch.make({ constellationId: CID }),
          ctx({ attempts: [draft(B, "b", STANDALONE)] })
        );

        for (const tasks of [
          [{ id: "inline-child", kind: "subagent" as const, description: "child" }],
          [],
        ])
          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.SessionBackgroundTasksChanged.make({ sessionId: WORKER, tasks }),
              ]),
          });
        yield* block();
        yield* finish(WORKER);
        yield* wait(() => Effect.succeed(starts.length === 2));
        expect(starts).toEqual([A, B]);
        expect((yield* resourceCounts(store)).workerCap).toEqual({ working: 1, waiting: 0 });
      })
    );
  }));

test("restart keeps an idle blocked assignment without admission; Lead delivery reacquires", () =>
  fixture(async (root) => {
    const file = `${root}/store.sqlite`;
    const starts: string[] = [];
    const first = world(file, { runtime: runtime(starts) });
    await first.run(
      Effect.gen(function* () {
        yield* setup();
        yield* wait(() => Effect.succeed(starts.length === 1));
        yield* block();
        yield* finish(WORKER);
        const store = yield* EventStore;
        yield* wait(() => Effect.map(resourceCounts(store), (s) => s.workerCap.working === 0));
        yield* leadMessage();
      })
    );
    const resumed = world(file, { runtime: runtime(starts) });
    await resumed.run(
      Effect.gen(function* () {
        yield* (yield* ConstellationRuntime).resumeWorking();
        const store = yield* EventStore;
        const resources = { get: resourceCounts(store) };
        expect((yield* resources.get).workerCap.working).toBe(0);
        const delivery = yield* ConstellationDelivery;
        yield* delivery.start();
        yield* wait(() => Effect.succeed(resumed.turns.length === 1));
        expect((yield* resources.get).workerCap.working).toBe(1);
        yield* delivery.flush();
        expect(resumed.turns).toHaveLength(1);
        expect(starts).toEqual([A]);
      })
    );
  }));

for (const action of ["Stop", "SendBack"] as const)
  test(`${action} cancels a blocked worker queued for resume without executing its input`, () =>
    fixture(async () => {
      const starts: string[] = [];
      const w = world(":memory:", { runtime: runtime(starts) });
      await w.run(
        Effect.gen(function* () {
          yield* setup();
          const store = yield* EventStore;
          yield* wait(() => Effect.succeed(starts.length === 1));
          yield* commit(
            C.Plan.make({
              constellationId: CID,
              operations: [PlanOperation.cases.Add.make({ task: task(B) })],
            })
          );
          yield* commit(
            C.Dispatch.make({ constellationId: CID }),
            ctx({ attempts: [draft(B, "b", STANDALONE)] })
          );
          yield* block();
          yield* finish(WORKER);
          yield* wait(() => Effect.succeed(starts.length === 2));
          yield* (yield* ConstellationDelivery).start();
          yield* leadMessage();
          yield* wait(() => Effect.map(resourceCounts(store), (r) => r.workerCap.waiting === 1));
          yield* commit(
            C.Review.make({
              constellationId: CID,
              attemptId: draft().id,
              revision: 1,
              action:
                action === "Stop"
                  ? ReviewAction.cases.Stop.make({ reason: "Stop queued resume" })
                  : ReviewAction.cases.SendBack.make({
                      reason: "Replace queued resume",
                      worker: WorkerPlacement.cases.Existing.make({ sessionId: WORKER }),
                    }),
            }),
            ctx({ attempts: action === "SendBack" ? [draft(A, "retry", WORKER)] : [] })
          );
          yield* wait(() =>
            Effect.map(
              resourceCounts(store),
              (r) => r.workerCap.waiting === (action === "Stop" ? 0 : 1)
            )
          );
          expect(w.turns).toHaveLength(0);
          expect((yield* resourceCounts(store)).workerCap.working).toBe(1);

          const events = yield* store.readConstellationEvents({
            constellationId: CID,
            after: 0,
            upTo: (yield* store.model).sequence,
          });

          expect(events.some((e) => Predicate.isTagged(e.event, "AttemptUnblocked"))).toBe(false);

          if (action === "SendBack") {
            yield* finish(STANDALONE);
            const b = draft(B, "b", STANDALONE);
            const claim = report(b.branch, "b-head");
            yield* commit(
              C.WorkerClaim.make({ constellationId: CID, attemptId: b.id, claim }),
              ctx({
                binding: { kind: "session", sessionId: STANDALONE },
                claimProbe: { branch: b.branch, head: claim.head, dirtyPaths: [] },
              })
            );
            yield* wait(() => Effect.succeed(starts.length === 3));
            expect(starts).toEqual([A, B, A]);
            expect(w.turns).toHaveLength(0);
          }
        })
      );
    }));
