import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  AttemptId,
  PlanOperation,
  SessionId,
  SetConstellationStateAction,
  TaskDefinition,
  TaskId,
} from "@polaris/protocol";
import { Effect, Layer, Schema } from "effect";
import { Constellations } from "../../constellation/service.ts";
import { ConstellationOwner, ConstellationRuntime } from "../../constellation/runtime.ts";
import { ConstellationDefaultsPath } from "../../constellation/defaults.ts";
import { EventStore } from "../../store/EventStore.ts";
import {
  attachConstellation,
  type ConstellationAttachment,
} from "../../harness/constellation/attachment.ts";
import { McpBinding } from "../binding.ts";
import { mcpHttp } from "../http.ts";
import { McpTokens } from "../tokens.ts";
import { revokeMcpBindings } from "../revoke.ts";
import { LEAD_TOOL_NAMES, WORKER_TOOL_NAMES } from "../testing.ts";
import { CID, HOST, LEAD, WS, seed, runtime } from "./eval.fixture.ts";

const layerFor = (root: string) =>
  Constellations.layer.pipe(
    Layer.provideMerge(
      Layer.effect(ConstellationRuntime, runtime(root, [])).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            EventStore.layerSqlite(join(root, "store.sqlite")),
            McpTokens.layer(join(root, "tokens.sqlite"))
          )
        )
      )
    ),
    Layer.provide(Layer.succeed(ConstellationOwner)(HOST)),
    Layer.provide(Layer.succeed(ConstellationDefaultsPath)(join(root, "defaults.json")))
  );

const Outcome = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(
    Schema.Struct({
      findings: Schema.optionalKey(Schema.Array(Schema.Struct({ code: Schema.String }))),
    })
  ),
});

/** "ok", or the first finding's code. */
const outcome = (result: typeof Outcome.Type) =>
  result.isError === true ? (result.structuredContent?.findings?.[0]?.code ?? "error") : "ok";

const decodeOutcome = Schema.decodeUnknownSync(Outcome);

interface ToolClient {
  readonly names: () => Promise<ReadonlyArray<string>>;
  readonly call: (name: string, input: typeof JsonObject.Type) => Promise<string>;
  readonly close: () => Promise<void>;
}

/** Claude's in-process server calls the attachment's tools. */
const inProcess = (attachment: ConstellationAttachment): ToolClient => ({
  names: async () => attachment.tools.map((tool) => tool.name),
  call: async (name, input) => {
    const tool = attachment.tools.find((item) => item.name === name);

    return tool === undefined ? "missing" : outcome(await tool.call(input));
  },
  close: async () => {},
});

/** Codex reaches the same tools over the Host's HTTP listener with a real MCP client. */
const overHttp = async (attachment: ConstellationAttachment): Promise<ToolClient> => {
  const client = new Client({ name: "eng-560", version: "1" });

  // SAFETY: SDK transport has the same runtime contract; its sessionId getter's undefined differs only under exactOptionalPropertyTypes.
  await client.connect(new StreamableHTTPClientTransport(new URL(attachment.url)) as Transport);

  return {
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call: async (name, input) =>
      outcome(decodeOutcome(await client.callTool({ name, arguments: input }))),
    close: () => client.close(),
  };
};

const task = (id: string) =>
  PlanOperation.cases.Add.make({
    task: new TaskDefinition({ id: TaskId.make(id), kind: "task", title: id, brief: "Work" }),
  });

const JsonObject = Schema.Record(Schema.String, Schema.Json);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(JsonObject));

/** A tool's arguments, before they cross the transport as JSON. */
interface ToolInput {
  readonly [field: string]:
    | typeof Schema.Json.Type
    | ToolInput
    | TaskInput
    | ReadonlyArray<TaskInput>;
}

type TaskInput = ReturnType<typeof task> | SetConstellationStateAction;

const asJson = (input: ToolInput) => decodeJson(JSON.stringify(input));

const A = SetConstellationStateAction.cases;

for (const kind of ["claude", "codex"] as const) {
  test(`${kind}: a Lead that archived its Constellation keeps its tools and starts the next one`, async () => {
    const root = newTempDir("polaris-eng560-", { short: true });

    const connect =
      kind === "claude" ? async (a: ConstellationAttachment) => inProcess(a) : overHttp;

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seed(root);
            const commands = yield* Constellations;
            const store = yield* EventStore;
            const { origin } = yield* mcpHttp(commands);
            const applied = new Set<number>();

            // The Daemon feeds committed events to the token store (constellation/host.ts).
            const settle = Effect.gen(function* () {
              const model = yield* store.model;

              for (const id of model.constellations.keys())
                for (const row of yield* store.readConstellationEvents({
                  constellationId: id,
                  after: 0,
                  upTo: model.sequence,
                }))
                  if (!applied.has(row.sequence)) {
                    applied.add(row.sequence);
                    yield* revokeMcpBindings(row.event);
                  }
            });

            const attach = (binding: McpBinding) =>
              attachConstellation(binding, origin, commands).pipe(
                Effect.flatMap((attachment) => Effect.promise(() => connect(attachment)))
              );

            const lead = yield* attach(
              McpBinding.cases.Plain.make({
                sessionId: LEAD,
                constellationId: CID,
                workspaceId: WS,
              })
            );

            const run = (name: string, input: ToolInput) =>
              Effect.promise(() => lead.call(name, asJson(input)));

            const start = (name: string) =>
              run("plan", { start: { name, workspaceId: WS }, operations: [] });

            expect(yield* start("Phase 1")).toBe("ok");
            yield* settle;

            const workerAttachment = yield* attachConstellation(
              McpBinding.cases.Worker.make({
                sessionId: SessionId.make("phase-1-worker"),
                constellationId: CID,
                attemptId: AttemptId.make("phase-1-attempt"),
              }),
              origin,
              commands
            );

            const worker = yield* Effect.promise(() => connect(workerAttachment));

            for (const action of [A.Resume.make({}), A.Complete.make({})])
              expect(yield* run("set_state", { action })).toBe("ok");
            yield* settle;

            expect(yield* run("dispatch", {})).toBe("E-COMPLETED");
            expect(yield* Effect.promise(() => worker.names())).toEqual(WORKER_TOOL_NAMES);

            expect(yield* run("set_state", { action: A.Archive.make({}) })).toBe("ok");
            yield* settle;

            expect(yield* Effect.promise(() => lead.names())).toEqual(LEAD_TOOL_NAMES);
            expect(yield* run("dispatch", {})).toBe("E-ARCHIVED");
            expect(yield* run("plan", { operations: [task("A0")] })).toBe("E-ARCHIVED");
            expect(yield* run("status", {})).toBe("ok");

            // The archived Constellation's worker stays revoked and never gains Lead tools.
            if (kind === "claude") {
              expect(yield* Effect.promise(() => worker.call("status", {}))).toBe("E-REVOKED");
              expect(yield* Effect.promise(() => worker.call("plan", { operations: [] }))).toBe(
                "missing"
              );
            } else {
              const response = yield* Effect.promise(() =>
                fetch(workerAttachment.url, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
                })
              );

              expect(response.status).toBe(401);
            }

            expect(yield* start("Phase 2")).toBe("ok");

            const graphs = () =>
              Effect.map(store.model, (model) =>
                [...model.constellations.values()].map(({ graph }) => graph)
              );

            const next = (yield* graphs()).find((graph) => graph.name === "Phase 2");
            expect(next?.leadSessionId).toBe(LEAD);
            expect(next?.id).not.toBe(CID);

            // Before and after the Daemon replays the start, the Lead's tools follow Phase 2.
            expect(yield* run("plan", { operations: [task("A1")] })).toBe("ok");
            yield* settle;
            expect(yield* run("plan", { operations: [task("A2")] })).toBe("ok");

            const after = yield* graphs();
            expect(after.find((graph) => graph.id === CID)).toMatchObject({ state: "archived" });
            expect(after.find((graph) => graph.id === CID)?.tasks).toEqual([]);

            expect(after.find((graph) => graph.id === next?.id)?.tasks.map((t) => t.id)).toEqual([
              TaskId.make("A1"),
              TaskId.make("A2"),
            ]);
            expect(yield* run("status", {})).toBe("ok");

            yield* Effect.promise(() => Promise.all([lead.close(), worker.close()]));
          })
        ).pipe(Effect.provide(layerFor(root)))
      );
    } finally {
      removeTempDir(root);
    }
  }, 20000);
}
