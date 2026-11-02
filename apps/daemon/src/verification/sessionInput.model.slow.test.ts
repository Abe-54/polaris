import { makeFakes, makeFakeDriver } from "../engine/testing.ts";
import { expect, test } from "bun:test";
import { Command, CommandId, MessageTarget } from "@polaris/protocol";
import { Effect, Fiber } from "effect";
import fc from "fast-check";
import { Engine } from "../engine/Engine.ts";
import { C, CID, HOST, draft } from "../engine/constellation.testing.ts";
import { inputQueueWorld } from "../constellation/composition/inputQueue.testing.ts";
import { startAttempt } from "../constellation/composition/workers.ts";
import { sendBack } from "../constellation/composition/sendback.testing.ts";
import { finish, send, setup, wait } from "../constellation/delivery/testing.ts";
import { sendbackWorld } from "../mcp/sendback.testing.ts";
import { recordSendbackTrace } from "../mcp/sendback.trace.testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { ConstellationOwner } from "../constellation/runtime.ts";
import { Constellations } from "../constellation/service.ts";
import { deliverLocalInput } from "../constellation/delivery/local.ts";
import { pendingInputs } from "../constellation/delivery/messages.ts";
import { applyWorkerDelivery } from "../constellation/delivery/turns.ts";
import { DeliveryInput } from "../constellation/delivery/inputs.ts";
import { pbtRuns, pbtSeed, pbtTimeout } from "./pbt.ts";

const runs = pbtRuns(20);

// The reference is arrival order minus canceled requests, independent of gate/readiness code.
test(
  "Session startup and later arrivals preserve FIFO across canceled waiters",
  async () => {
    let trace = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          before: fc.integer({ min: 2, max: 5 }),
          later: fc.integer({ min: 1, max: 3 }),
          cancel: fc.option(fc.integer({ min: 0, max: 4 })),
          steer: fc.boolean(),
          leadRoute: fc.constantFrom("none", "local", "remote"),
        }),
        async (sample) => {
          const { driver, layer } = inputQueueWorld(
            makeFakes(),
            makeFakeDriver("codex", { steer: true })
          );

          await sendbackWorld(":memory:", false).run(
            Effect.gen(function* () {
              yield* setup();
              const engine = yield* Engine;
              const store = yield* EventStore;
              const sid = draft().sessionId;
              yield* send(sid, "Old Turn");
              const old = (yield* store.model).sessions.get(sid)!.turns.at(-1)!;
              yield* engine.runCommittedTurn(old, old.prompt);
              const oldHarness = driver.latest(sid)!;
              const attempt = yield* sendBack();
              const graph = (yield* store.model).constellations.get(CID)!.graph;
              const requests = [];
              const expected: string[] = [];

              const enqueue = (id: number) =>
                engine
                  .dispatch({
                    commandId: CommandId.make(`request-${id}`),
                    deviceLabel: "test",
                    command: Command.cases.SendTurn.make({
                      sessionId: sid,
                      prompt: `Prompt ${id}`,
                      attachments: [],
                    }),
                  })
                  .pipe(Effect.forkChild);

              for (let i = 0; i < sample.before; i++) {
                const fiber = yield* enqueue(i);
                yield* Effect.yieldNow;

                if (i === sample.cancel) yield* Fiber.interrupt(fiber);
                else {
                  requests.push(fiber);
                  expected.push(`Prompt ${i}`);
                }
              }

              const startup = yield* startAttempt(graph, attempt).pipe(Effect.forkChild);

              if (sample.steer) {
                yield* engine.dispatch({
                  commandId: CommandId.make("old-steer"),
                  deviceLabel: "test",
                  command: Command.cases.Steer.make({ sessionId: sid, text: "Old Turn steering" }),
                });
                yield* wait(() => Effect.succeed(oldHarness.steers.length === 1));
              }

              yield* finish(sid);
              yield* Fiber.join(startup);
              const expectedSteers: string[] = [];

              if (sample.leadRoute !== "none") {
                const graphs = yield* Constellations;
                yield* graphs.command(
                  { kind: "user" },
                  CommandId.make("live-lead"),
                  C.Message.make({
                    constellationId: CID,
                    target: MessageTarget.cases.Worker.make({ attemptId: attempt.id }),
                    text: "Steer the brief",
                  })
                );
                const input = pendingInputs((yield* store.model).constellations.get(CID)!)[0]!;

                const delivery =
                  sample.leadRoute === "local"
                    ? deliverLocalInput(CID, input)
                    : applyWorkerDelivery(
                        {
                          id: "remote-lead",
                          ownerHostId: HOST,
                          workerHostId: HOST,
                          constellationId: CID,
                          attemptId: attempt.id,
                          sessionId: sid,
                          input: DeliveryInput.Turn({ text: input.text, cause: "message" }),
                        },
                        () => Effect.void
                      );

                const delivered = yield* delivery.pipe(Effect.forkChild);
                yield* wait(() => Effect.succeed(driver.latest(sid)!.steers.length === 1));
                yield* Fiber.join(delivered);
                expectedSteers.push(input.text);
                expect(driver.latest(sid)!.steers).toEqual(expectedSteers);
                expect(driver.latest(sid)!.turns).toHaveLength(1);
              }

              yield* finish(sid);
              yield* Fiber.join(requests[0]!);
              yield* wait(() => Effect.succeed(driver.latest(sid)!.turns.length === 2));

              for (let i = sample.before; i < sample.before + sample.later; i++) {
                requests.push(yield* enqueue(i));
                expected.push(`Prompt ${i}`);
                yield* Effect.yieldNow;
              }

              for (let i = 1; i < requests.length; i++) {
                yield* finish(sid);
                yield* Fiber.join(requests[i]!);
                yield* wait(() => Effect.succeed(driver.latest(sid)!.turns.length === i + 2));
                expect(
                  driver
                    .latest(sid)!
                    .turns.slice(1)
                    .map((t) => t.prompt)
                ).toEqual(expected.slice(0, i + 1));
              }

              const tail = yield* enqueue(sample.before + sample.later);
              yield* Effect.yieldNow;
              expect(driver.latest(sid)!.turns.length).toBe(requests.length + 1);
              yield* finish(sid);
              yield* Fiber.join(tail);
              yield* wait(() =>
                Effect.succeed(driver.latest(sid)!.turns.length === requests.length + 2)
              );
              expect(driver.latest(sid)!.turns.at(-1)!.prompt).toBe(
                `Prompt ${sample.before + sample.later}`
              );
              expect(driver.latest(sid)!.steers).toEqual(expectedSteers);
              expect(oldHarness.steers).toEqual(sample.steer ? ["Old Turn steering"] : []);
              yield* recordSendbackTrace(`fifo-model-${trace++}`);
            }).pipe(Effect.provide(layer), Effect.provideService(ConstellationOwner, HOST))
          );
        }
      ),
      { numRuns: runs, ...pbtSeed() }
    );
  },
  pbtTimeout(runs, 100)
);
