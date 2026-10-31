import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PlanOperation, TaskDefinition, TaskId, TurnId } from "@polaris/protocol";
import { Effect, Fiber, Layer, Predicate, Schema, Stream } from "effect";
import { Constellations } from "../../constellation/service.ts";
import { ConstellationOwner, ConstellationRuntime } from "../../constellation/runtime.ts";
import { ConstellationDefaultsPath } from "../../constellation/defaults.ts";
import { EventStore } from "../../store/EventStore.ts";
import { makeBenchDriver } from "../../harness/bench/BenchDriver.ts";
import { HarnessEvent } from "../../harness/HarnessDriver.ts";
import { attachConstellation } from "../../harness/constellation/attachment.ts";
import { McpBinding } from "../binding.ts";
import { McpTokens } from "../tokens.ts";
import { LEAD_TOOL_NAMES } from "../testing.ts";
import { revokeMcpBindings } from "../revoke.ts";
import { DomainEvent } from "@polaris/protocol";
import { CID, HOST, LEAD, WS, seed, runtime, repo } from "./eval.fixture.ts";
import { shortTemp } from "../../platform/testing.ts";

for (const kind of ["codex", "claude"] as const) {
  test(`${kind} plain session follows the preamble to start a Constellation, then uses the same Lead tools`, async () => {
    const root = mkdtempSync(shortTemp("polaris-g2-probe-"));

    const base = Layer.mergeAll(
      EventStore.layerSqlite(join(root, "store.sqlite")),
      McpTokens.layer(join(root, "tokens.sqlite"))
    );

    const layer = Constellations.layer.pipe(
      Layer.provideMerge(
        Layer.effect(ConstellationRuntime, runtime(root, [])).pipe(Layer.provideMerge(base))
      ),
      Layer.provide(Layer.succeed(ConstellationOwner)(HOST)),
      Layer.provide(Layer.succeed(ConstellationDefaultsPath)(join(root, "defaults.json")))
    );

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seed(root);
            const commands = yield* Constellations;
            const store = yield* EventStore;

            const binding = McpBinding.cases.Plain.make({
              sessionId: LEAD,
              constellationId: CID,
              workspaceId: WS,
            });

            const attachment = yield* attachConstellation(
              binding,
              "http://127.0.0.1:12345",
              commands
            );

            const names = attachment.tools.map((tool) => tool.name);
            expect(names).toEqual(LEAD_TOOL_NAMES);
            const plan = attachment.tools.find((tool) => tool.name === "plan")!;
            const status = attachment.tools.find((tool) => tool.name === "status")!;
            const early = yield* Effect.promise(() => plan.call({ operations: [] }));
            expect(early.structuredContent?.findings?.[0]?.code).toBe("E-START-FIRST");
            expect((yield* store.model).constellations.size).toBe(0);
            const before = readdirSync(repo(root, "G1"));

            const opened = yield* makeBenchDriver(kind).open({
              sessionId: LEAD,
              cwd: repo(root, "G1"),
              permissionMode: "supervised",
              model: null,
              effort: null,
              resumeCursor: null,
              constellation: attachment,
            });

            const events: HarnessEvent[] = [];

            const drain = yield* opened.events.pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  events.push(event);
                })
              ),
              Stream.takeUntil(HarnessEvent.$is("TurnEnded")),
              Stream.runDrain,
              Effect.forkScoped
            );

            yield* opened.sendTurn({
              turnId: TurnId.make("probe"),
              prompt: "create a test constellation",
              attachments: [],
              model: null,
              effort: null,
            });
            yield* Fiber.join(drain);

            const items = events.flatMap((event) =>
              HarnessEvent.$is("ItemCompleted")(event) ? [event.item] : []
            );

            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({
              name: "mcp__polaris__plan",
              status: "completed",
              input: { start: { name: "Test constellation", workspaceId: WS }, operations: [] },
            });
            expect(readdirSync(repo(root, "G1"))).toEqual(before);
            expect((yield* store.model).constellations.get(CID)?.graph.leadSessionId).toBe(LEAD);
            expect((yield* Effect.promise(() => status.call({ json: true }))).isError).not.toBe(
              true
            );

            const mapped = yield* Effect.promise(() =>
              plan.call(
                Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
                  JSON.stringify({
                    operations: [
                      PlanOperation.cases.Add.make({
                        task: new TaskDefinition({
                          id: TaskId.make("A1"),
                          kind: "task",
                          title: "Test task",
                          brief: "Verify bootstrap",
                        }),
                      }),
                    ],
                  })
                )
              )
            );

            expect(mapped.isError).not.toBe(true);

            const dispatched = yield* Effect.promise(() =>
              attachment.tools

                .find((tool) => tool.name === "dispatch")!

                .call({ tasks: [{ taskId: "A1", worker: { session: "worker-A1" } }] })
            );

            expect(dispatched.isError).not.toBe(true);
            expect((yield* store.model).constellations.get(CID)?.graph.attempts).toHaveLength(1);

            const token = attachment.url.split("/").at(-1)!;
            const tokens = yield* McpTokens;
            expect(yield* tokens.authenticate(token)).toEqual(binding);
            yield* revokeMcpBindings(
              DomainEvent.cases.SessionStateChanged.make({
                sessionId: LEAD,
                state: "archived",
                reason: null,
              })
            );
            expect(yield* tokens.authenticate(token)).toBeNull();
            expect(
              (yield* Effect.promise(() => status.call({}))).structuredContent?.findings?.[0]?.code
            ).toBe("E-REVOKED");

            const rows = yield* store.readConstellationEvents({
              constellationId: CID,
              after: 0,

              upTo: (yield* store.model).sequence,
            });

            expect(
              rows.filter((row) => Predicate.isTagged(row.event, "ConstellationStarted"))
            ).toHaveLength(1);
          })
        ).pipe(Effect.provide(layer))
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
}
