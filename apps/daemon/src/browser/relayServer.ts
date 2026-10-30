/**
 * The CDP relay's loopback listener (ENG-616): `ws://127.0.0.1:<port>/browser/<sessionId>/<token>`
 * upgrades to an agent's socket, and `/json/version`, `/json/list` under the same path answer
 * agent-browser's discovery for that session only. Host and Origin are checked as `mcp/http.ts`
 * does, so a page in a browser cannot reach it. The URL is a secret: it is never logged.
 */
import { NO_DESKTOP_APP_MESSAGE, SessionId } from "@polaris/protocol";
import type { Server, ServerWebSocket } from "bun";
import { Effect, Option, Schema } from "effect";
import type { CdpRelayStore } from "./relayStore.ts";
import { cdpRelayUrl } from "./relayUrl.ts";
import { RelaySocket, type RelaySocketData, type RelaySocketHooks } from "./relaySocket.ts";

export interface RelayServerOptions {
  readonly port: number;
  /** The Daemon's version, for `/json/version`'s `Browser`. */
  readonly version: string;
  readonly store: CdpRelayStore["Service"];
  /** Whether `token` opens `sessionId` now: a live token of a session that is still live. */
  readonly authenticate: (sessionId: SessionId, token: string) => Effect.Effect<boolean>;
  readonly hooks: RelaySocketHooks;
  /** Whether a Desktop App hosts the session now, for discovery's answer. */
  readonly hosted: (sessionId: SessionId) => Effect.Effect<boolean>;
}

const ROUTE = /^\/browser\/([^/]+)\/([a-f0-9]{64})(?:\/(json\/version|json\/list|json))?\/?$/;

const Route = Schema.Struct({ sessionId: SessionId, token: Schema.String, page: Schema.String });

const decodeRoute = Schema.decodeUnknownOption(Route);

const routeOf = (pathname: string) => {
  const match = ROUTE.exec(pathname);

  if (match === null) return Option.none();

  try {
    return decodeRoute({
      sessionId: decodeURIComponent(match[1] ?? ""),
      token: match[2],
      page: match[3] ?? "",
    });
  } catch {
    return Option.none();
  }
};

const safeOrigin = (request: Request) => {
  const origin = request.headers.get("origin");

  if (origin === null) return true;

  try {
    const url = new URL(origin);

    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.host === new URL(request.url).host
    );
  } catch {
    return false;
  }
};

const noDesktopApp = () => new Response(NO_DESKTOP_APP_MESSAGE, { status: 503 });

const discovery = (
  options: RelayServerOptions,
  route: typeof Route.Type,
  port: number
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!(yield* options.hosted(route.sessionId))) return noDesktopApp();
    const url = cdpRelayUrl(port, route.sessionId, route.token);

    if (route.page === "json/version")
      return Response.json({
        Browser: `Polaris/${options.version}`,
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: url,
      });
    const tabs = yield* options.store.remembered(route.sessionId).pipe(Effect.orDie);

    return Response.json(
      tabs.map((tab) => ({
        id: tab.targetId,
        type: "page",
        title: tab.title,
        url: tab.url,
        description: "",
        devtoolsFrontendUrl: "",
        webSocketDebuggerUrl: url,
      }))
    );
  });

const websocket = (hooks: RelaySocketHooks) => ({
  perMessageDeflate: false,
  idleTimeout: 0,
  sendPings: false,
  closeOnBackpressureLimit: false,
  open(socket: ServerWebSocket<RelaySocketData>) {
    const relay = new RelaySocket(socket.data.sessionId, socket, hooks);
    socket.data.relay = relay;
    relay.start();
  },
  message(socket: ServerWebSocket<RelaySocketData>, message: string | Buffer) {
    socket.data.relay?.message(message);
  },
  drain(socket: ServerWebSocket<RelaySocketData>) {
    socket.data.relay?.drain();
  },
  close(socket: ServerWebSocket<RelaySocketData>) {
    socket.data.relay?.peerClosed();
  },
});

const fetchOf =
  (options: RelayServerOptions) =>
  async (request: Request, server: Server<RelaySocketData>): Promise<Response | undefined> => {
    const url = new URL(request.url);

    if (url.hostname !== "127.0.0.1" || !safeOrigin(request))
      return new Response(null, { status: 403 });
    const route = routeOf(url.pathname);

    if (Option.isNone(route)) return new Response(null, { status: 404 });

    const authentic = await Effect.runPromise(
      options.authenticate(route.value.sessionId, route.value.token)
    );

    if (!authentic) return new Response(null, { status: 401 });

    if (route.value.page !== "")
      return request.method === "GET"
        ? Effect.runPromise(discovery(options, route.value, server.port ?? options.port))
        : new Response(null, { status: 405, headers: { Allow: "GET" } });

    if (server.upgrade(request, { data: { sessionId: route.value.sessionId, relay: null } }))
      return undefined;

    return new Response("This is a Polaris CDP relay; open a WebSocket here", {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  };

/** Listens for the lifetime of the scope. */
export const startRelayServer = (options: RelayServerOptions) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve<RelaySocketData>({
        hostname: "127.0.0.1",
        port: options.port,
        development: false,
        maxRequestBodySize: 64 * 1024,
        fetch: fetchOf(options),
        websocket: websocket(options.hooks),
        error: () => new Response("The CDP relay request failed", { status: 500 }),
      })
    ),
    (server) =>
      Effect.promise(async () => {
        await server.stop(true);
      })
  );
