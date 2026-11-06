import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Semaphore, Predicate } from "effect";
import {
  CommandId,
  ConstellationSettings,
  DomainEvent,
  PlanOperation,
  SessionId,
} from "@polaris/protocol";
import {
  A,
  B,
  C,
  CID,
  LEAD,
  WS,
  ctx,
  draft,
  report,
  task,
} from "../engine/constellation.testing.ts";
import { decideConstellation } from "../engine/constellation.ts";
import { workingAttemptsLayer } from "./working.ts";
import { EventStore, StoreConfig } from "../store/EventStore.ts";
import { decideConstellationJournal } from "./journal.ts";

const waitFor = Effect.fnUntraced(function* (condition: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    yield* Effect.sleep(1);
  }

  throw new Error("worker scope did not settle");
});

test("committed hooks replay archives at startup and recover a dropped bounded observer", async () => {
  let observed = 0;

  const archived = DomainEvent.cases.SessionStateChanged.make({
    sessionId: LEAD,
    state: "archived",
    reason: null,
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.commit({ commandId: null, decide: () => Effect.succeed([archived]) });

        const hooks = workingAttemptsLayer({
          runtime: {
            prepare: () =>
              Effect.succeed({
                attempts: [],
                newLeadSessionId: null,
                claimProbe: null,
                recordedChecks: [],
              }),
            afterCommit: () => Effect.void,
            resumeWorking: () => Effect.void,
          },
          acquireWorker: () => Effect.void,
          startWorker: () => Effect.void,
          resumeWorker: () => Effect.void,
          failed: () => Effect.void,
          eventCommitted: () =>
            Effect.andThen(
              Effect.sleep(2),
              Effect.sync(() => {
                observed++;
              })
            ),
        }).pipe(Layer.provide(Layer.succeed(EventStore)(store)));

        yield* Layer.build(hooks);
        expect(observed).toBe(1);
        yield* store.commit({
          commandId: null,
          decide: () => Effect.succeed(Array.from({ length: 20 }, () => archived)),
        });
        yield* waitFor(() => observed === 21);
      })
    ).pipe(
      Effect.provide(EventStore.layerSqlite(":memory:")),
      Effect.provideService(StoreConfig, { subscriberCapacity: 1 })
    )
  );
});

test("a startup replay that cannot read the log fails the build instead of hanging it", async () => {
  const unreadable = new Error('Expected "SessionCreated" | … at ["_tag"]');

  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* EventStore;

        const hooks = workingAttemptsLayer({
          runtime: {
            prepare: () =>
              Effect.succeed({
                attempts: [],
                newLeadSessionId: null,
                claimProbe: null,
                recordedChecks: [],
              }),
            afterCommit: () => Effect.void,
            resumeWorking: () => Effect.void,
          },
          acquireWorker: () => Effect.void,
          startWorker: () => Effect.void,
          resumeWorker: () => Effect.void,
          failed: () => Effect.void,
        }).pipe(
          Layer.provide(
            // A newer Daemon's event in the log: this Daemon's schema can't decode it.
            Layer.succeed(EventStore)({ ...store, readEvents: () => Effect.die(unreadable) })
          )
        );

        return yield* Layer.build(hooks).pipe(Effect.timeout("2 seconds"), Effect.exit);
      })
    ).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
  );

  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(unreadable);
});

const slotLifetime = async (stopWaiter: boolean) => {
  const started: Array<string> = [];
  let held = 0;
  let waiting = 0;

  const program = Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    const store = yield* EventStore;

    const hooks = workingAttemptsLayer({
      runtime: {
        prepare: () =>
          Effect.succeed({
            attempts: [],
            newLeadSessionId: null,
            claimProbe: null,
            recordedChecks: [],
          }),
        afterCommit: () => Effect.void,
        resumeWorking: () => Effect.void,
      },
      acquireWorker: () =>
        Effect.uninterruptibleMask((restore) =>
          Effect.acquireRelease(
            restore(
              Effect.gen(function* () {
                waiting++;
                yield* semaphore.take(1).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      waiting--;
                    })
                  )
                );
                held++;
              })
            ),
            () =>
              Effect.gen(function* () {
                held--;
                yield* semaphore.release(1);
              })
          )
        ),
      startWorker: (attempt) =>
        Effect.sync(() => {
          started.push(attempt.taskId);
        }),
      resumeWorker: () => Effect.void,
      failed: () => Effect.void,
    });

    const runtimeLayer = hooks.pipe(Layer.provide(Layer.succeed(EventStore)(store)));
    const built = yield* Layer.build(runtimeLayer);
    const runtime = yield* importRuntime.pipe(Effect.provide(built));

    const commit = Effect.fnUntraced(function* (
      id: string,
      command: import("@polaris/protocol").ConstellationCommand,
      context: import("../engine/constellation.inputs.ts").ConstellationContext = ctx()
    ) {
      const result = yield* store.commit({
        commandId: CommandId.make(id),
        decide: (model) => {
          const decision = decideConstellation(model.constellations.get(CID), command, context);

          return decision.rejection === null
            ? Effect.succeed(decision.events)
            : Effect.fail(decision.rejection);
        },
      });

      if (Predicate.isTagged(result, "Committed"))
        yield* runtime.afterCommit({ kind: "user" }, command, result.envelopes);
    });

    yield* commit(
      "plan",
      C.Plan.make({
        constellationId: CID,
        start: {
          name: "slots",
          workspaceId: WS,
          leadSessionId: LEAD,
          settings: new ConstellationSettings({}),
        },
        operations: [task(A), task(B)].map((t) => PlanOperation.cases.Add.make({ task: t })),
      })
    );
    const a = draft(A, "a", SessionId.make("worker-a"));
    const b = draft(B, "b", SessionId.make("worker-b"));
    yield* commit("dispatch", C.Dispatch.make({ constellationId: CID }), ctx({ attempts: [a, b] }));
    yield* waitFor(() => started.length === 1 && waiting === 1);
    expect(started).toEqual([A]);
    expect(held).toBe(1);

    if (stopWaiter) {
      yield* store.commit({
        commandId: null,
        decide: (model) => {
          const decision = decideConstellationJournal(
            model.constellations.get(CID)!,
            { type: "settle", attemptId: b.id, outcome: "lost", reason: "stopped waiting" },
            ctx()
          );

          return decision.rejection === null
            ? Effect.succeed(decision.events)
            : Effect.fail(decision.rejection);
        },
      });
      yield* waitFor(() => waiting === 0);
    }

    yield* commit(
      "claim",
      C.WorkerClaim.make({ constellationId: CID, attemptId: a.id, claim: report() }),
      ctx({
        binding: { kind: "session", sessionId: a.sessionId },
        claimProbe: { dirtyPaths: [], branch: a.branch, head: "head" },
      })
    );

    if (stopWaiter) {
      yield* waitFor(() => held === 0);
      expect(started).toEqual([A]);

      return;
    }

    yield* waitFor(() => started.length === 2);
    expect(started).toEqual([A, B]);
    expect(held).toBe(1);
    yield* store.commit({
      commandId: null,
      decide: (model) => {
        const record = model.constellations.get(CID)!;

        const decision = decideConstellationJournal(
          record,
          { type: "settle", attemptId: b.id, outcome: "failed", reason: "Harness failed" },
          ctx()
        );

        return decision.rejection === null
          ? Effect.succeed(decision.events)
          : Effect.fail(decision.rejection);
      },
    });
    yield* waitFor(() => held === 0);
  });

  await Effect.runPromise(
    Effect.scoped(program).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
  );
};

test("Claim releases its working slot so the FIFO waiter can start", () => slotLifetime(false));

test("stopping a queued Attempt cancels its slot wait and prevents startup", () =>
  slotLifetime(true));

import { ConstellationRuntime } from "./runtime.ts";

const importRuntime = ConstellationRuntime;

test("resumeWorking reacquires an existing assignment once without starting a first Turn", async () => {
  let held = 0;
  let admissions = 0;
  let resumed = 0;
  let started = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* EventStore;

        const plan = decideConstellation(
          undefined,
          C.Plan.make({
            constellationId: CID,
            start: {
              name: "recovered",
              workspaceId: WS,
              leadSessionId: LEAD,
              settings: ConstellationSettings.make({}),
            },
            operations: [PlanOperation.cases.Add.make({ task: task(A) })],
          }),
          ctx()
        );

        yield* store.commit({ commandId: null, decide: () => Effect.succeed(plan.events) });

        const dispatched = decideConstellation(
          (yield* store.model).constellations.get(CID),
          C.Dispatch.make({ constellationId: CID }),
          ctx({ attempts: [draft(A)] })
        );

        yield* store.commit({ commandId: null, decide: () => Effect.succeed(dispatched.events) });

        const built = yield* Layer.build(
          workingAttemptsLayer({
            runtime: {
              prepare: () =>
                Effect.succeed({
                  attempts: [],
                  newLeadSessionId: null,
                  claimProbe: null,
                  recordedChecks: [],
                }),
              afterCommit: () => Effect.void,
              resumeWorking: () => Effect.void,
            },
            acquireWorker: () => {
              admissions++;

              return Effect.acquireRelease(
                Effect.sync(() => {
                  held++;
                }),
                () =>
                  Effect.sync(() => {
                    held--;
                  })
              );
            },
            startWorker: () =>
              Effect.sync(() => {
                started++;
              }),
            resumeWorker: () =>
              Effect.sync(() => {
                resumed++;
              }),
            failed: () => Effect.void,
          }).pipe(Layer.provide(Layer.succeed(EventStore)(store)))
        );

        const runtime = yield* ConstellationRuntime.pipe(Effect.provide(built));
        expect(held).toBe(0);
        yield* runtime.resumeWorking();
        yield* runtime.resumeWorking();
        // Each resume registers its admission before returning, so a second resume would show here.
        expect(admissions).toBe(1);
        yield* waitFor(() => resumed === 1);
        expect(held).toBe(1);
        expect(started).toBe(0);
      })
    ).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
  );
  expect(held).toBe(0);
});
