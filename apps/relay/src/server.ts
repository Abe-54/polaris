/**
 * The relay's WebSocket server on Bun.serve. It proves each party's key,
 * forwards data frames between linked parties by their header alone, and
 * holds nothing it forwards beyond the send call.
 */
import {
  type Auth,
  decodeClientControl,
  type Live,
  verifyLiveTicket,
  type Wake,
  type WakeOutcome,
  verifyPushTicket,
  encodeControl,
  fromBase64Url,
  MAX_RECORD_BYTES,
  MAX_RELAY_MESSAGE_BYTES,
  NONCE_BYTES,
  RELAY_ADDRESS_LENGTH,
  RELAY_ADDRESS_PATTERN,
  RELAY_PATH,
  RELAY_WIRE_VERSION,
  type RelayAddress,
  RelayClose,
  RelayOp,
  authMessage,
  relayAddress,
  toBase64Url,
  verifyEd25519,
} from "@polaris/protocol/relay";
import { Match, Option, Predicate } from "effect";
import type { Server, ServerWebSocket } from "bun";
import type { RelayConfig } from "./config.ts";
import { type Endpoint, Hub } from "./hub.ts";
import { ConnectionGate, TokenBucket, WakeLimiter } from "./limits.ts";
import { LiveActivities } from "./live.ts";
import { type Deliver, pushClient } from "./push.ts";
import type { EmitWideEvent } from "./wideEvent.ts";

type Phase = "challenged" | "verifying" | "ready";

interface Connection {
  readonly id: string;
  readonly ip: string;
  readonly opened: number;
  readonly nonce: Uint8Array;
  readonly messages: TokenBucket;
  readonly bytes: TokenBucket;
  phase: Phase;
  endpoint: Endpoint | null;
  /** The party's own address as bytes, written over a forward's destination. */
  source: Uint8Array | null;
  authTimer: ReturnType<typeof setTimeout> | null;
  endedBy: string;
  framesIn: number;
  bytesIn: number;
  framesOut: number;
  bytesOut: number;
  controlIn: number;
  unreachable: number;
  dropped: number;
  wakesIn: number;
}

type Socket = ServerWebSocket<Connection>;

export interface RelayHandle {
  readonly port: number;
  readonly connections: () => number;
  readonly stop: () => Promise<void>;
}

const SWEEP_INTERVAL_MS = 60_000;

/** A data frame's header: version, op, the address's length, and the address. */
const HEADER_BYTES = 3 + RELAY_ADDRESS_LENGTH;

/** The address schema's check alone, without a decode, for the per-frame path. */
const isRelayAddress = (text: string): text is RelayAddress => RELAY_ADDRESS_PATTERN.test(text);

/** The destination of a well-formed forward, or null. Reads the header only. */
const forwardPeer = (bytes: Buffer): RelayAddress | null => {
  if (
    bytes.byteLength < HEADER_BYTES ||
    bytes[0] !== RELAY_WIRE_VERSION ||
    bytes[1] !== RelayOp.Forward ||
    bytes[2] !== RELAY_ADDRESS_LENGTH ||
    bytes.byteLength - HEADER_BYTES > MAX_RECORD_BYTES
  )
    return null;
  const peer = bytes.toString("latin1", 3, HEADER_BYTES);

  return isRelayAddress(peer) ? peer : null;
};

const clientIp = (request: Request, server: Server<Connection>, trustProxy: boolean): string => {
  const forwarded = trustProxy ? request.headers.get("x-forwarded-for") : null;
  const first = forwarded?.split(",")[0]?.trim();

  return first !== undefined && first !== "" ? first : (server.requestIP(request)?.address ?? "");
};

const newConnection = (config: RelayConfig, ip: string): Connection => ({
  id: toBase64Url(crypto.getRandomValues(new Uint8Array(9))),
  ip,
  opened: performance.now(),
  nonce: crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
  messages: new TokenBucket(config.messagesPerSecond, config.messagesPerSecond * 2),
  bytes: new TokenBucket(config.bytesPerSecond, config.bytesPerSecond * 2),
  phase: "challenged",
  endpoint: null,
  source: null,
  authTimer: null,
  endedBy: "peer",
  framesIn: 0,
  bytesIn: 0,
  framesOut: 0,
  bytesOut: 0,
  controlIn: 0,
  unreachable: 0,
  dropped: 0,
  wakesIn: 0,
});

/** Closes `ws` from the relay's side, recording why for its wide event. */
const end = (ws: Socket, code: number, reason: string) => {
  if (ws.data.endedBy === "peer") ws.data.endedBy = reason;
  ws.close(code, reason);
};

/** A frame this large gains nothing from sharing a write, so it is sent at once. */
const DIRECT_BYTES = 8 * 1024;

/** Publishes a frame to one socket's topic; 0 when nothing took it. */
type Publish = (topic: string, frame: Uint8Array) => number;

/**
 * A party's endpoint. Small data frames go through the socket's own topic: the server writes
 * a turn's worth in one system call, and a direct send drains them first, so order holds.
 */
const endpointFor = (
  ws: Socket,
  auth: typeof Auth.Type,
  address: Endpoint["address"],
  publish: Publish
): Endpoint => {
  const data = ws.data;
  ws.subscribe(data.id);

  return {
    address,
    role: auth.role,
    send: (message) => {
      if (ws.send(message) === 0) data.dropped++;
    },
    forward: (frame) => {
      const sent = frame.byteLength < DIRECT_BYTES ? publish(data.id, frame) : ws.send(frame);

      if (sent === 0) {
        data.dropped++;

        return;
      }

      data.framesOut++;
      data.bytesOut += frame.byteLength;
    },
    replace: () => end(ws, RelayClose.Replaced, "replaced"),
  };
};

export const startRelay = (
  config: RelayConfig,
  emit: EmitWideEvent,
  /** For tests: the push service; by default the one `config.push` names, if any. */
  deliver: Deliver | null = config.push === null ? null : pushClient(config.push)
): RelayHandle => {
  const hub = new Hub();
  const gate = new ConnectionGate(config);
  let wakesInFlight = 0;
  const wakeLimits = new WakeLimiter(config.wakesPerMinute, config.wakeBurst);

  /** Hands one request to the push service, within the in-flight cap wakes share. */
  const deliverBounded: Deliver = async (request) => {
    if (deliver === null || wakesInFlight >= config.maxWakesInFlight) return "unavailable";
    wakesInFlight++;

    try {
      return await deliver(request);
    } finally {
      wakesInFlight--;
    }
  };

  const live = new LiveActivities({
    deliver: deliverBounded,
    gone: (hosts, token, outcome) => {
      for (const host of hosts)
        hub.host(host)?.send(encodeControl({ t: "live-gone", token, outcome }));
    },
    delivered: (outcome, hosts, alert) => emit({ event: "relay.live", outcome, hosts, alert }),
    maxActivities: config.maxLiveActivities,
    maxPerHost: config.maxPeers,
    hostGoneMs: config.liveHostGoneMs,
  });

  const limits = {
    maxMessageBytes: MAX_RELAY_MESSAGE_BYTES,
    maxPeers: config.maxPeers,
    messagesPerSecond: config.messagesPerSecond,
    bytesPerSecond: config.bytesPerSecond,
    authTimeoutMs: config.authTimeoutMs,
    idleTimeoutSeconds: config.idleTimeoutSeconds,
  };

  const authenticate = async (ws: Socket, auth: typeof Auth.Type) => {
    const key = fromBase64Url(auth.key);
    const signature = fromBase64Url(auth.sig);
    const peers = auth.peers ?? [];

    const valid =
      Option.isSome(key) &&
      Option.isSome(signature) &&
      (auth.role === "host" || auth.peers === undefined) &&
      (await verifyEd25519(key.value, authMessage(ws.data.nonce, auth.role), signature.value));

    if (ws.readyState !== WebSocket.OPEN) return;

    if (!valid || !Option.isSome(key)) return end(ws, RelayClose.AuthFailed, "auth-failed");

    if (peers.length > config.maxPeers) return end(ws, RelayClose.BadMessage, "too-many-peers");
    const address = await relayAddress(key.value);

    if (ws.readyState !== WebSocket.OPEN) return;
    clearTimeout(ws.data.authTimer ?? undefined);
    ws.data.phase = "ready";
    ws.data.source = Buffer.from(address, "latin1");
    ws.data.endpoint = endpointFor(ws, auth, address, publish);
    ws.send(encodeControl({ t: "ready", address }));
    hub.attach(ws.data.endpoint, peers);

    if (ws.data.endpoint.role === "host") live.hostBack(address);
  };

  const answerWake = (ws: Socket, wake: Wake, outcome: WakeOutcome, started: number) => {
    emit({ event: "relay.wake", outcome, durationMs: Math.round(performance.now() - started) });

    if (ws.readyState === WebSocket.OPEN)
      ws.data.endpoint?.send(encodeControl({ t: "woken", id: wake.id, outcome }));
  };

  /**
   * Forwards a host's wake when the device's ticket lets this host wake it at that token,
   * online or not. Never logs what it carries.
   */
  const onWake = async (ws: Socket, endpoint: Endpoint, wake: Wake) => {
    const started = performance.now();
    ws.data.wakesIn++;

    if (!wakeLimits.take(endpoint.address)) return answerWake(ws, wake, "rate-limited", started);
    const { token, environment, payload, ticket, peer } = wake;

    if (!(await verifyPushTicket(ticket, peer, endpoint.address, environment, token)))
      return answerWake(ws, wake, "unlinked", started);

    answerWake(ws, wake, await deliverBounded({ token, environment, payload }), started);
  };

  /**
   * Keeps a host's slice of a device's Live Activity when the device's live ticket lets this
   * host update it at that token. An alert spends the host's wake budget, or goes as routine.
   */
  const onLive = async (ws: Socket, endpoint: Endpoint, frame: Live) => {
    const { token, environment, ticket, peer } = frame;

    if (!(await verifyLiveTicket(ticket, peer, endpoint.address, environment, token))) {
      if (ws.readyState === WebSocket.OPEN)
        endpoint.send(encodeControl({ t: "live-gone", token, outcome: "unlinked" }));

      return;
    }

    if (deliver === null) return;
    const alert = frame.alert && frame.slice !== null && wakeLimits.take(endpoint.address);
    live.put({ ...frame, host: endpoint.address, alert });
  };

  const onControl = (ws: Socket, text: string) => {
    ws.data.controlIn++;
    const message = decodeClientControl(text);

    if (Option.isNone(message)) return end(ws, RelayClose.BadMessage, "bad-control");
    const { phase, endpoint } = ws.data;

    Match.value(message.value).pipe(
      Match.discriminatorsExhaustive("t")({
        auth: (auth) => {
          if (phase !== "challenged") return end(ws, RelayClose.BadMessage, "auth-twice");
          ws.data.phase = "verifying";
          void authenticate(ws, auth);
        },
        peers: ({ peers }) => {
          if (endpoint?.role !== "host") return end(ws, RelayClose.BadMessage, "peers-not-host");

          if (peers.length > config.maxPeers)
            return end(ws, RelayClose.BadMessage, "too-many-peers");
          hub.setPeers(endpoint, peers);
          live.unlisted(endpoint.address, new Set(peers));
        },
        wake: (wake) => {
          if (endpoint?.role !== "host") return end(ws, RelayClose.BadMessage, "wake-not-host");
          void onWake(ws, endpoint, wake);
        },
        live: (frame) => {
          if (endpoint?.role !== "host") return end(ws, RelayClose.BadMessage, "live-not-host");
          void onLive(ws, endpoint, frame);
        },
      })
    );
  };

  /**
   * Forwards one data frame. Source and destination addresses are the same length, so the
   * sender's is written over the destination and the received buffer goes on, uncopied.
   */
  const onData = (ws: Socket, bytes: Buffer) => {
    const { endpoint, source } = ws.data;

    if (endpoint === null || source === null)
      return end(ws, RelayClose.BadMessage, "data-before-ready");
    const peer = forwardPeer(bytes);

    if (peer === null) return end(ws, RelayClose.BadMessage, "bad-frame");
    ws.data.framesIn++;
    const target = hub.route(endpoint, peer);

    if (target === undefined) {
      ws.data.unreachable++;
      endpoint.send(encodeControl({ t: "unreachable", peer }));

      return;
    }

    bytes.set(source, 3);
    target.forward(bytes);
  };

  const publish: Publish = (topic, frame) => server.publish(topic, frame);

  const server = Bun.serve<Connection>({
    port: config.port,
    hostname: config.hostname,
    fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") return new Response("ok");

      if (url.pathname !== RELAY_PATH) return new Response("Not found", { status: 404 });
      const ip = clientIp(request, server, config.trustProxy);
      const refusal = gate.admit(ip);

      if (refusal !== null) {
        emit({ event: "relay.refused", reason: refusal });

        return new Response(refusal, { status: refusal === "relay-full" ? 503 : 429 });
      }

      if (server.upgrade(request, { data: newConnection(config, ip) })) return undefined;
      gate.release(ip);

      return new Response("Expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_RELAY_MESSAGE_BYTES,
      idleTimeout: config.idleTimeoutSeconds,
      sendPings: true,
      backpressureLimit: config.backpressureLimitBytes,
      closeOnBackpressureLimit: true,
      publishToSelf: false,
      open(ws) {
        ws.data.authTimer = setTimeout(
          () => end(ws, RelayClose.AuthTimeout, "auth-timeout"),
          config.authTimeoutMs
        );
        ws.send(
          encodeControl({
            t: "challenge",
            v: 1,
            nonce: toBase64Url(ws.data.nonce),
            limits,
            push: deliver !== null,
          })
        );
      },
      message(ws, message) {
        const size = Predicate.isString(message) ? Buffer.byteLength(message) : message.byteLength;
        ws.data.bytesIn += size;
        const now = performance.now();

        if (!ws.data.messages.take(1, now) || !ws.data.bytes.take(size, now))
          return end(ws, RelayClose.RateLimited, "rate-limited");

        if (ws.data.phase === "verifying") return end(ws, RelayClose.BadMessage, "early-message");

        if (Predicate.isString(message)) return onControl(ws, message);

        if (ws.data.phase !== "ready") return end(ws, RelayClose.BadMessage, "data-before-ready");
        onData(ws, message);
      },
      close(ws, code) {
        const data = ws.data;
        clearTimeout(data.authTimer ?? undefined);

        if (data.endpoint !== null) hub.detach(data.endpoint);

        if (data.endpoint?.role === "host" && hub.host(data.endpoint.address) === undefined)
          live.hostGone(data.endpoint.address);
        gate.release(data.ip);
        emit({
          event: "relay.connection",
          conn: data.id,
          role: data.endpoint?.role ?? null,
          authenticated: data.endpoint !== null,
          durationMs: Math.round(performance.now() - data.opened),
          framesIn: data.framesIn,
          bytesIn: data.bytesIn,
          framesOut: data.framesOut,
          bytesOut: data.bytesOut,
          controlIn: data.controlIn,
          unreachable: data.unreachable,
          dropped: data.dropped,
          wakes: data.wakesIn,
          closeCode: code,
          endedBy: data.endedBy,
        });
      },
    },
  });

  const sweep = setInterval(() => {
    gate.sweep();
    wakeLimits.sweep();
  }, SWEEP_INTERVAL_MS);

  sweep.unref();
  const port = server.port ?? config.port;
  emit({ event: "relay.start", port });

  return {
    port,
    connections: () => gate.connections,
    stop: async () => {
      clearInterval(sweep);
      live.stop();
      await server.stop(true);
    },
  };
};
