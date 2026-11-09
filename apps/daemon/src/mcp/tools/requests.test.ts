import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConstellationId, RequestId, WorkspaceId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { withTraceFixture } from "../../traces/testing.ts";
import { withServer } from "../../requests/sends.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { RequestSends } from "../../requests/sendsService.ts";
import { OriginApprovals, READS_ONLY, registerOriginGate } from "../../requests/approvals/index.ts";
import { McpBinding } from "../binding.ts";
import { McpTokens } from "../tokens.ts";
import { mcpHttp } from "../http.ts";
import { fakeCommands } from "../testing.ts";
import { unavailableSessions } from "../sessions/index.ts";
import { sessionRequestTools } from "../sessions/requests.ts";
import { attachSessionTools, constellationTools } from "./index.ts";
import { nodeOwner, respond, runWithSends, sessionId, tunnelOwner } from "./requests.testing.ts";

const binding = McpBinding.cases.Plain.make({
  sessionId,
  constellationId: ConstellationId.make("c-requests"),
  workspaceId: WorkspaceId.make("workspace"),
});

const TOKEN = "dotenv-token-5d1e9a";

const Pending = Schema.Struct({ pending: Schema.Literal(true), approvalId: RequestId });

const echo = (request: Request) =>
  new Response(
    `auth=${request.headers.get("authorization")} trace=${request.headers.get("traceparent")}`,
    {
      headers: { "x-echo": request.headers.get("authorization") ?? "" },
    }
  );

test("send_request over real MCP HTTP returns status, body and traceId, with the {{$dotenv}} token masked", () =>
  withTraceFixture(async (f) => {
    await writeFile(join(f.root, ".env"), `API_TOKEN=${TOKEN}\n`);

    await withServer(echo, (base) =>
      runWithSends(
        f,
        nodeOwner,
        Effect.gen(function* () {
          const { origin } = yield* mcpHttp(fakeCommands().commands);
          const token = yield* (yield* McpTokens).issue(binding);
          const client = new Client({ name: "requests-test", version: "1" });

          yield* Effect.promise(async () => {
            try {
              // SAFETY: the SDK's optional sessionId differs only under exactOptionalPropertyTypes.
              await client.connect(
                new StreamableHTTPClientTransport(new URL(`${origin}/mcp/${token}`)) as Transport
              );

              const result = await client.callTool({
                name: "send_request",
                arguments: {
                  method: "GET",
                  url: `${base}/me`,
                  headers: { Authorization: "Bearer {{$dotenv API_TOKEN}}" },
                },
              });

              expect(result.isError).toBeFalsy();
              const out = JSON.stringify(result);
              expect(out).not.toContain(TOKEN);

              const data = Schema.decodeUnknownSync(
                Schema.Struct({
                  status: Schema.Number,
                  body: Schema.String,
                  traceId: Schema.String,
                })
              )(result.structuredContent);

              expect(data.status).toBe(200);
              expect(data.body).toStartWith("auth=Bearer ");
              expect(data.body).toContain(`trace=00-${data.traceId}-`);
              expect(out).toContain(`call trace with this id`);
            } finally {
              await client.close();
            }
          });
        }).pipe(Effect.provide(McpTokens.layer(join(f.root, "tokens.sqlite"))))
      )
    );
  }));

/** The catalog over the real engine and gate; approvals wait 50 ms instead of the 55 s budget. */
const remoteTool = Effect.gen(function* () {
  const store = yield* EventStore;
  const sends = yield* RequestSends;
  const approvals = yield* OriginApprovals;
  yield* registerOriginGate;
  const requests = sessionRequestTools(store, sends, approvals);
  const { commands } = fakeCommands();

  attachSessionTools(commands, {
    ...unavailableSessions,
    requests: { ...requests, awaitApproval: (id, write) => approvals.awaitApproval(id, write, 50) },
  });

  const tool = constellationTools(binding, commands).find((item) => item.name === "send_request")!;

  return { tool, sends };
});

test("a remote origin returns pending, then sends after the user approves", () =>
  withTraceFixture((f) =>
    withServer(echo, (base) =>
      runWithSends(
        f,
        tunnelOwner,
        Effect.gen(function* () {
          const { tool, sends } = yield* remoteTool;
          const input = { method: "GET", url: `${base}/items` };
          const first = yield* Effect.promise(() => tool.call(input));
          const { approvalId } = Schema.decodeUnknownSync(Pending)(first.structuredContent);
          expect((yield* sends.page(f.root)).sends).toHaveLength(0);

          yield* respond(approvalId, "reads");
          const second = yield* Effect.promise(() => tool.call(input));

          expect(second.isError).toBeFalsy();
          expect(second.structuredContent).toMatchObject({ status: 200, outcome: "ok" });
        })
      )
    )
  ));

test("a reads approval denies a POST, recorded as a denied Send", () =>
  withTraceFixture((f) =>
    withServer(echo, (base) =>
      runWithSends(
        f,
        tunnelOwner,
        Effect.gen(function* () {
          const { tool, sends } = yield* remoteTool;
          const input = { method: "POST", url: `${base}/items`, body: "{}" };
          const first = yield* Effect.promise(() => tool.call(input));
          const { approvalId } = Schema.decodeUnknownSync(Pending)(first.structuredContent);

          yield* respond(approvalId, "reads");
          const second = yield* Effect.promise(() => tool.call(input));

          expect(second.isError).toBe(true);
          expect(second.structuredContent).toMatchObject({
            code: "E-ORIGIN-DENIED",
            message: READS_ONLY,
          });

          const log = (yield* sends.page(f.root)).sends;
          expect(log.map((send) => [send.method, send.outcome, send.traceId])).toEqual([
            ["POST", "denied", null],
          ]);
        })
      )
    )
  ));
