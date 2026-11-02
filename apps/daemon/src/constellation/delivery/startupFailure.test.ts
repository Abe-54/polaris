import { expect, test } from "bun:test";
import { CommandId, MessageTarget, PlanOperation } from "@polaris/protocol";
import { Effect, Layer, Predicate } from "effect";
import { A, B, C, CID, HOST, ctx, draft, task } from "../../engine/constellation.testing.ts";
import { decideConstellation } from "../../engine/constellation.ts";
import { EventStore } from "../../store/EventStore.ts";
import { HostResources } from "../../resources/index.ts";
import { ConstellationOwner, ConstellationRuntime } from "../runtime.ts";
import { Constellations } from "../service.ts";
import { workingAttemptsLayer } from "../working.ts";
import { ConstellationDelivery } from "./index.ts";
import { deliverLocalInput } from "./local.ts";
import { pendingInputs } from "./messages.ts";
import { send, setup, STANDALONE, wait, WORKER, world } from "./testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

for (const mode of ["acquire", "start", "resume"] as const)
  test(`${mode} failure rejects later Lead input without stalling another Session`, async () => {
    const root = newTempDir("blocked-startup-failure-", { short: true });
    const previous = process.env.POLARIS_HOME;
    process.env.POLARIS_HOME = root;
    const failures: string[] = [];
    const starts: string[] = [];
    const file = `${root}/store.sqlite`;

    const runtime = Layer.unwrap(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const resources = yield* HostResources;
        yield* resources.setWorkerCap(CommandId.make("cap"), 1);

        return workingAttemptsLayer<
          | string
          | import("@polaris/protocol").ResourceError
          | import("../../services.ts").ServiceError
        >({
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
          acquireWorker: (id) =>
            id === WORKER && mode === "acquire"
              ? Effect.fail("acquire failed")
              : resources.acquireWorker(id),
          startWorker: (attempt) =>
            attempt.sessionId === WORKER
              ? Effect.fail("start failed")
              : send(attempt.sessionId).pipe(
                  Effect.provideService(EventStore, store),
                  Effect.orDie,
                  Effect.andThen(
                    store.commit({
                      commandId: CommandId.make(`${attempt.id}:start`),
                      decide: () => Effect.succeed([]),
                    })
                  ),
                  Effect.andThen(Effect.sync(() => starts.push(attempt.taskId))),
                  Effect.asVoid
                ),
          resumeWorker: () => Effect.fail("resume failed"),
          failed: (_attempt, error) => Effect.sync(() => failures.push(String(error))),
        });
      })
    ).pipe(Layer.provide(HostResources.layer), Layer.orDie);

    try {
      if (mode === "resume") await world(file).run(setup());
      const w = world(file, { runtime });
      await w.run(
        Effect.gen(function* () {
          if (mode === "resume") yield* (yield* ConstellationRuntime).resumeWorking();
          else yield* setup();
          yield* wait(() => Effect.succeed(failures.length === 1));
          const store = yield* EventStore;
          const graphs = yield* Constellations;

          const command = (value: import("@polaris/protocol").ConstellationCommand) =>
            graphs.command({ kind: "user" }, CommandId.make(crypto.randomUUID()), value);

          yield* command(
            C.Message.make({
              constellationId: CID,
              target: MessageTarget.cases.Worker.make({ attemptId: draft().id }),
              text: "Retry failed A",
            })
          );

          const input = pendingInputs((yield* store.model).constellations.get(CID)!).find(
            (i) => i.sessionId === WORKER
          )!;

          yield* deliverLocalInput(CID, input).pipe(
            Effect.provideService(ConstellationOwner, HOST),
            Effect.timeout(200)
          );
          expect(w.turns).toHaveLength(0);
          expect(
            pendingInputs((yield* store.model).constellations.get(CID)!).some(
              (i) => i.id === input.id
            )
          ).toBe(true);
          yield* command(
            C.Plan.make({
              constellationId: CID,
              operations: [PlanOperation.cases.Add.make({ task: task(B) })],
            })
          );
          const b = draft(B, "b", STANDALONE);
          const dispatch = C.Dispatch.make({ constellationId: CID });

          const result = yield* store.commit({
            commandId: CommandId.make(crypto.randomUUID()),
            decide: (model) => {
              const decision = decideConstellation(
                model.constellations.get(CID),
                dispatch,
                ctx({ attempts: [b] })
              );

              expect(decision.rejection).toBeNull();

              return Effect.succeed(decision.events);
            },
          });

          if (Predicate.isTagged(result, "Committed"))
            yield* (yield* ConstellationRuntime).afterCommit(
              { kind: "user" },
              dispatch,
              result.envelopes
            );
          yield* wait(() => Effect.succeed(starts.includes(B)));
          expect(starts).toEqual([B]);
          yield* command(
            C.Message.make({
              constellationId: CID,
              target: MessageTarget.cases.Worker.make({ attemptId: b.id }),
              text: "Continue B",
            })
          );
          const delivery = yield* ConstellationDelivery;
          yield* delivery.start().pipe(Effect.timeout(200));
          yield* delivery.flush().pipe(Effect.timeout(200));
          yield* wait(() => Effect.succeed(w.steers.some((text) => text.includes("Continue B"))));
          expect(starts).toEqual([B]);
          expect(w.steers).not.toContain("Retry failed A");
          expect(
            (yield* store.model).constellations
              .get(CID)!
              .graph.attempts.find((a) => a.taskId === A)!.state
          ).toBe("working");
        })
      );
    } finally {
      if (previous === undefined) delete process.env.POLARIS_HOME;
      else process.env.POLARIS_HOME = previous;
      removeTempDir(root);
    }
  });
