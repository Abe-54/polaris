/**
 * `polaris_desktop` over Streamable HTTP (JSON responses) for Codex, on 127.0.0.1 only. Each
 * session gets a random 256-bit path token that lives as long as its scope; nothing is stored.
 */
import { randomBytes } from "node:crypto";
import { Effect, Option, Schema, type Scope } from "effect";
import type { jsonSchema } from "../../mcp/tools/shared.ts";
import type { Json } from "./catalog.ts";
import { loopbackRequest } from "../../transport/loopbackHttp.ts";
import type { DesktopResult } from "./envelope.ts";

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ReturnType<typeof jsonSchema>;
  readonly annotations: { readonly readOnlyHint: boolean };
}

export interface HttpSession {
  readonly tools: ReadonlyArray<ListedTool>;
  readonly instructions: string;
  readonly call: (name: string, input: Json, signal: AbortSignal) => Promise<DesktopResult>;
}

const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

const decodeInitialize = Schema.decodeUnknownOption(
  Schema.Struct({ protocolVersion: Schema.String })
);

const decodeCall = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Json) })
);

type RpcResult =
  | DesktopResult
  | { readonly tools: ReadonlyArray<ListedTool> }
  | { readonly protocolVersion: string; readonly instructions: string }
  | Record<never, never>;

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const rpcError = (id: string | number | null, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

const answer = async (
  session: HttpSession,
  message: typeof Message.Type,
  signal: AbortSignal
): Promise<Response> => {
  const id = message.id;

  if (id === undefined)
    return message.method.startsWith("notifications/")
      ? new Response(null, { status: 202 })
      : rpcError(null, -32600, "A request needs an id");
  const result = (value: RpcResult) => Response.json({ jsonrpc: "2.0", id, result: value });

  switch (message.method) {
    case "initialize": {
      const version = Option.getOrNull(decodeInitialize(message.params))?.protocolVersion;

      return result({
        protocolVersion:
          version !== undefined && VERSIONS.includes(version) ? version : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "polaris_desktop", version: "1" },
        instructions: session.instructions,
      });
    }

    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: session.tools });
    case "tools/call": {
      const params = Option.getOrNull(decodeCall(message.params));

      if (params === null || !session.tools.some((tool) => tool.name === params.name))
        return rpcError(id, -32602, "No such tool");

      return result(await session.call(params.name, params.arguments ?? {}, signal));
    }

    default:
      return rpcError(id, -32601, "Method not found");
  }
};

/** One listener for the Host, started by the first Codex session that needs it. */
export const desktopHttp = () => {
  const sessions = new Map<string, HttpSession>();
  let server: ReturnType<typeof Bun.serve> | null = null;

  const fetch = async (request: Request) => {
    if (!loopbackRequest(request)) return new Response(null, { status: 403 });
    const token = /^\/desktop\/([a-f0-9]{64})$/.exec(new URL(request.url).pathname)?.[1];
    const session = token === undefined ? undefined : sessions.get(token);

    if (session === undefined) return new Response(null, { status: 401 });

    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const message = decodeMessage(await request.text());

    if (Option.isNone(message)) return rpcError(null, -32600, "Invalid JSON-RPC message");

    return answer(session, message.value, request.signal);
  };

  const listening = () =>
    (server ??= Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 1024 * 1024,
      fetch,
      error: () => new Response("MCP request failed", { status: 500 }),
    }));

  return {
    /** The session's URL while the scope lasts; the listener stops with the last session. */
    serve: (session: HttpSession): Effect.Effect<string, never, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const token = randomBytes(32).toString("hex");
          sessions.set(token, session);

          return { token, url: `http://127.0.0.1:${listening().port}/desktop/${token}` };
        }),
        ({ token }) =>
          Effect.promise(async () => {
            sessions.delete(token);

            if (sessions.size > 0 || server === null) return;
            const stopping = server;
            server = null;
            await stopping.stop(true);
          })
      ).pipe(Effect.map(({ url }) => url)),
  };
};
