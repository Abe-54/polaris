import { shortTemp } from "../../platform/testing.ts";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { AgentSession, DomainEvent, Workspace } from "@polaris/protocol";
import { session, send } from "../../constellation/delivery/testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { TraceRuntime, TraceSessions, TraceStore, traceReceiver } from "../../traces/index.ts";
import { postTraces, spanFixture, traceFixture, TRACE_ID } from "../../traces/testing.ts";
import { McpTokens } from "../tokens.ts";
import { mcpHttp } from "../http.ts";
import { fakeCommands } from "../testing.ts";
import { bindings, plainBinding } from "./data.testing.ts";

const Reply = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optionalKey(Schema.Boolean),
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
    structuredContent: Schema.Record(Schema.String, Schema.Json),
  }),
});

test("real OTLP receiver to SQLite to MCP HTTP resolves each binding's session, checkout and current Turn", async () => {
  const root = await realpath(await mkdtemp(shortTemp("t2-mcp-http-")));
  const cwd = join(root, "package");
  await mkdir(cwd);

  const workspace = new Workspace({
    id: plainBinding.workspaceId,
    path: root,
    name: "trace HTTP fixture",
    isGitRepo: false,
    worktreeRoot: `${root}.worktrees`,
    hidden: false,
    registeredAt: new Date().toISOString(),
  });

  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);

  const layer = TraceRuntime.layerAt(join(root, "trace-tokens.json"), port).pipe(
    Layer.provideMerge(TraceStore.layerAt(join(root, "traces.sqlite"))),
    Layer.provideMerge(TraceSessions.layer),
    Layer.provideMerge(EventStore.layerSqlite(":memory:")),
    Layer.provideMerge(McpTokens.layer(join(root, "mcp.sqlite")))
  );

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventStore;
          const runtime = yield* TraceRuntime;
          const tokens = yield* McpTokens;
          yield* traceReceiver({ port });
          const { origin } = yield* mcpHttp(fakeCommands().commands);

          yield* events.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([DomainEvent.cases.WorkspaceRegistered.make({ workspace })]),
          });

          for (const binding of bindings) {
            yield* events.commit({
              commandId: null,
              decide: () =>
                Effect.succeed([
                  DomainEvent.cases.SessionCreated.make({
                    session: Schema.decodeUnknownSync(AgentSession)({
                      ...Schema.encodeSync(AgentSession)(session(binding.sessionId)),
                      workspaceId: workspace.id,
                      cwd,
                    }),
                  }),
                ]),
            });
            yield* send(binding.sessionId, "Inspect this operation");
            const setup = yield* runtime.setup(binding.sessionId);
            const token = yield* tokens.issue(binding);
            yield* Effect.promise(async () => {
              const span = spanFixture({ id: "abcdef1234567890" });
              expect((await postTraces(setup.endpoint!, traceFixture([span]))).status).toBe(200);

              const call = async (name: string, args: Schema.Json) => {
                const response = await fetch(`${origin}/mcp/${token}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: name,
                    method: "tools/call",
                    params: { name, arguments: args },
                  }),
                });

                return Schema.decodeUnknownSync(Reply)(await response.json()).result;
              };

              const listed = await call("traces", {});
              expect(listed.isError).not.toBe(true);
              expect(listed.structuredContent.traces).toMatchObject([
                { id: TRACE_ID, turn: { sessionId: binding.sessionId, number: 1 } },
              ]);
              const tree = await call("trace", { id: TRACE_ID.slice(0, 8) });
              expect(tree.content[0]!.text).toContain("POST /orders · 12.3 ms · 1 spans");
              const full = await call("span", { trace: TRACE_ID, span: "abcdef12" });
              expect(full.structuredContent.span).toMatchObject({
                polaris: { sessionId: binding.sessionId, checkout: root },
                attributes: { "http.request.header.authorization": "[redacted]" },
              });
              const forged = await call("traces", { checkout: "/other", turn: "all" });
              expect(forged.structuredContent.code).toBe("E-INPUT");
            });
          }
        }).pipe(Effect.provide(layer))
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
