/**
 * The `polaris_simulator` MCP server: one loopback Streamable HTTP listener per Daemon, JSON
 * responses only, where each Agent Session's URL carries its own random token.
 */
import { Effect, Option, Schema } from "effect";
import { loopbackRequest } from "../../transport/loopbackHttp.ts";
import type { SimulatorSession, ToolResult } from "./session.ts";
import type { SimulatorTool } from "./tools.ts";

const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

const Initialize = Schema.Struct({ protocolVersion: Schema.String });

const Call = Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Json) });

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

const decodeInitialize = Schema.decodeUnknownOption(Initialize);

const decodeCall = Schema.decodeUnknownOption(Call);

const PROTOCOL_VERSION = "2025-11-25";

const VERSIONS = [PROTOCOL_VERSION, "2025-06-18", "2025-03-26"];

const rpcError = (id: string | number | null, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

/** An initialize, ping, tools/list or tools/call result. */
type McpResult =
  | ToolResult
  | typeof Schema.Json.Type
  | { readonly tools: ReadonlyArray<ListedTool> };

interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: SimulatorTool["inputSchema"];
  readonly annotations: { readonly readOnlyHint: boolean };
}

const TOKEN = /^\/simulator-mcp\/([a-f0-9]{64})$/;

export const responseFor = async (
  session: SimulatorSession,
  tools: ReadonlyArray<SimulatorTool>,
  message: typeof Message.Type
): Promise<Response> => {
  const id = message.id;

  if (id === undefined)
    return message.method.startsWith("notifications/")
      ? new Response(null, { status: 202 })
      : rpcError(null, -32600, "A request needs an id");

  const result = (value: McpResult) => Response.json({ jsonrpc: "2.0", id, result: value });

  if (message.method === "initialize") {
    const params = decodeInitialize(message.params);

    if (Option.isNone(params)) return rpcError(id, -32602, "Invalid initialize parameters");
    const asked = params.value.protocolVersion;

    return result({
      protocolVersion: VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "polaris_simulator", version: "1" },
    });
  }

  if (message.method === "ping") return result({});

  if (message.method === "tools/list")
    return result({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly },
      })),
    });

  if (message.method !== "tools/call") return rpcError(id, -32601, "Method not found");
  const params = decodeCall(message.params);

  if (Option.isNone(params)) return rpcError(id, -32602, "Invalid tool call parameters");
  const tool = tools.find((item) => item.name === params.value.name);

  if (tool === undefined) return rpcError(id, -32602, `No tool named ${params.value.name}`);

  return result(await tool.call(session, params.value.arguments));
};

/** The listener while the scope lasts; `resolve` maps a URL's token to its session. */
export const simulatorMcpHttp = (
  resolve: (token: string) => SimulatorSession | null,
  tools: ReadonlyArray<SimulatorTool>,
  port = 0
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        maxRequestBodySize: 1024 * 1024,
        // A first open may take minutes; the call answers before then (session.ts).
        idleTimeout: 0,
        fetch: async (request) => {
          if (!loopbackRequest(request)) return new Response(null, { status: 403 });
          const token = TOKEN.exec(new URL(request.url).pathname)?.[1];
          const session = token === undefined ? null : resolve(token);

          if (session === null) return new Response(null, { status: 401 });

          if (request.method !== "POST")
            return new Response(null, { status: 405, headers: { Allow: "POST" } });

          if (!request.headers.get("content-type")?.startsWith("application/json"))
            return new Response(null, { status: 415 });
          const message = decodeMessage(await request.text());

          if (Option.isNone(message)) return rpcError(null, -32600, "Invalid JSON-RPC message");

          return responseFor(session, tools, message.value);
        },
        error: () => new Response("MCP request failed", { status: 500 }),
      })
    ),
    (server) => Effect.promise(() => server.stop(true))
  ).pipe(Effect.map((server) => ({ origin: `http://127.0.0.1:${server.port}` })));

export const sessionPath = (token: string) => `/simulator-mcp/${token}`;
