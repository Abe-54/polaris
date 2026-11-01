import { Profiles } from "../traces/profiles/service.ts";
import { sessionProfileTools } from "./sessions/profiles.ts";
import { Effect, Option, Schema } from "effect";
import type { McpBinding } from "./binding.ts";
import { EventStore } from "../store/EventStore.ts";
import { type Notifier, notifier, type SessionTools, sessionTools } from "./sessions/index.ts";
import {
  type CatalogOptions,
  type ConstellationCommands,
  type LeadStarted,
  attachSessionTools,
  attachVisualizations,
  constellationTools,
} from "./tools.ts";
import { DataSources, DataQueries } from "../data/services.ts";
import { TraceStore } from "../traces/storeService.ts";
import { TraceRuntime } from "../traces/runtimeService.ts";
import { TraceSessions } from "../traces/sessionsService.ts";
import { sessionTraceTools } from "./sessions/traces.ts";
import { sessionDataTools } from "./sessions/data.ts";
import { McpTokens } from "./tokens.ts";
import { loopbackRequest } from "../transport/loopbackHttp.ts";

const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

const Initialize = Schema.Struct({ protocolVersion: Schema.String });

const Call = Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Json) });

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const decodeMessage = Schema.decodeUnknownOption(Message);

const decodeInitialize = Schema.decodeUnknownOption(Initialize);

const decodeCall = Schema.decodeUnknownOption(Call);

const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];

const protocolVersion = "2025-11-25";

const rpcError = (id: string | number | null, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

const responseFor = async (
  binding: McpBinding,
  message: typeof Message.Type,
  commands: ConstellationCommands,
  started: LeadStarted,
  options: CatalogOptions,
  signal?: AbortSignal
): Promise<Response> => {
  const id = message.id;

  if (id === undefined) {
    return message.method.startsWith("notifications/")
      ? new Response(null, { status: 202 })
      : rpcError(null, -32600, "A request needs an id");
  }

  const result = <A>(value: A) => Response.json({ jsonrpc: "2.0", id, result: value });

  switch (message.method) {
    case "initialize": {
      const params = decodeInitialize(message.params);

      if (Option.isNone(params)) return rpcError(id, -32602, "Invalid initialize parameters");

      return result({
        protocolVersion: versions.includes(params.value.protocolVersion)
          ? params.value.protocolVersion
          : protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "polaris", version: "1" },
      });
    }

    case "ping":
      return result({});
    case "tools/list":
      return result({
        tools: constellationTools(binding, commands, started, options).map(
          ({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            annotations,
          })
        ),
      });
    case "tools/call": {
      const params = decodeCall(message.params);

      if (Option.isNone(params)) return rpcError(id, -32602, "Invalid tool call parameters");

      const tool = constellationTools(binding, commands, started, options).find(
        (item) => item.name === params.value.name
      );

      if (tool === undefined) return rpcError(id, -32602, "This binding has no such tool");

      return result(await tool.call(params.value.arguments ?? {}, signal));
    }

    default:
      return rpcError(id, -32601, "Method not found");
  }
};

/** One listener per Host; JSON responses only, with no SSE connection or per-session process. */
export const mcpHttp = (
  commands: ConstellationCommands,
  port = 0,
  requestSecret?: SessionTools["requestSecret"]
) =>
  Effect.gen(function* () {
    const tokens = yield* McpTokens;
    const store = yield* Effect.serviceOption(EventStore);

    const started: LeadStarted = (sessionId, id) =>
      Effect.ignore(tokens.advanceLeads(sessionId, id));

    const notifications: Notifier | null = Option.isSome(store) ? notifier(store.value) : null;

    // The same commands reach Claude's in-process tools, so they serve the session tools too.
    const sources = yield* Effect.serviceOption(DataSources);
    const queries = yield* Effect.serviceOption(DataQueries);
    const traceStore = yield* Effect.serviceOption(TraceStore);
    const traceRuntime = yield* Effect.serviceOption(TraceRuntime);
    const traceSessions = yield* Effect.serviceOption(TraceSessions);
    const profiles = yield* Effect.serviceOption(Profiles);

    if (Option.isSome(store) && notifications !== null) {
      const sessions = sessionTools(store.value, notifications, requestSecret);

      const data =
        Option.isSome(sources) && Option.isSome(queries)
          ? sessionDataTools(store.value, sources.value, queries.value)
          : undefined;

      if (
        Option.isSome(traceStore) &&
        Option.isSome(traceRuntime) &&
        Option.isSome(traceSessions)
      ) {
        Object.assign(sessions, {
          traces: sessionTraceTools(
            traceStore.value,
            traceRuntime.value,
            traceSessions.value,
            Option.getOrUndefined(sources)
          ),
        });
      }

      if (Option.isSome(profiles) && Option.isSome(traceSessions) && Option.isSome(traceStore))
        Object.assign(sessions, {
          profiles: sessionProfileTools(profiles.value, traceSessions.value, traceStore.value),
        });

      attachSessionTools(
        commands,
        Object.assign(sessions, data === undefined ? undefined : { data })
      );
    }

    attachVisualizations(commands, tokens.visualizations);

    const active = new Map<string, AbortController>();

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port,
          maxRequestBodySize: 1024 * 1024,
          fetch: async (request) => {
            const url = new URL(request.url);

            if (!loopbackRequest(request)) return new Response(null, { status: 403 });
            const token = /^\/mcp\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];

            const binding =
              token === undefined ? null : await Effect.runPromise(tokens.authenticate(token));

            if (binding === null) return new Response(null, { status: 401 });

            if (request.method !== "POST")
              return new Response(null, { status: 405, headers: { Allow: "POST" } });

            if (!request.headers.get("content-type")?.startsWith("application/json"))
              return new Response(null, { status: 415 });
            const version = request.headers.get("mcp-protocol-version");

            if (version !== null && !versions.includes(version))
              return new Response(null, { status: 400 });
            const json = decodeJson(await request.text());

            if (Option.isNone(json)) return rpcError(null, -32700, "Invalid JSON");
            const message = decodeMessage(json.value);

            if (Option.isNone(message)) return rpcError(null, -32600, "Invalid JSON-RPC message");

            const key = (id: string | number) => `${token}:${JSON.stringify(id)}`;

            if (message.value.method === "notifications/cancelled") {
              const cancelled = Schema.decodeUnknownOption(
                Schema.Struct({ requestId: Schema.Union([Schema.String, Schema.Number]) })
              )(message.value.params);

              if (Option.isSome(cancelled)) active.get(key(cancelled.value.requestId))?.abort();

              return new Response(null, { status: 202 });
            }

            const controller = new AbortController();
            const id = message.value.id;

            if (id !== undefined) active.set(key(id), controller);

            try {
              return await responseFor(
                binding,
                message.value,
                commands,
                started,
                {
                  visualize: url.searchParams.get("visuals") !== "off",
                },
                AbortSignal.any([request.signal, controller.signal])
              );
            } finally {
              if (id !== undefined && active.get(key(id)) === controller) active.delete(key(id));
            }
          },
          error: () => new Response("MCP request failed", { status: 500 }),
        })
      ),
      (listener) =>
        Effect.promise(async () => {
          await listener.stop(true);
        })
    );

    // Polaris's own notifications share `notify`'s window (constellation/attention.ts).
    return { origin: `http://127.0.0.1:${server.port}`, notifications };
  });
