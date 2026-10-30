/**
 * Shared test harness for the byte-stream suites (ENG-613): a throwaway Daemon home, a Daemon
 * with the byte-stream handlers, Clients over the local socket, `polaris bridge` or a raw node
 * socket we can drop, loopback TCP servers, and the byte helpers. Each suite calls `freshHome`
 * and `cleanupHome` from its own `beforeEach`/`afterEach`.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  type AddressInfo,
  connect as netConnect,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { join } from "node:path";
import {
  type ByteStreamSession,
  connectRpc,
  HostTarget,
  makeHostConnection,
  spawnTransport,
} from "@polaris/client";
import { type Capability, readEvents, writeEvents } from "@polaris/protocol";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { type Duration, Effect, Fiber, Layer, Scope, Stream } from "effect";
import { BrowserHosting, ByteStreamQuota, HostAddressStreams } from "../browser/index.ts";
import { shortTemp } from "../platform/testing.ts";
import { ByteStreamRpcsLive } from "./byteStreams.ts";
import { startServer } from "./server.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");

let home = "";

export const freshHome = () => {
  home = mkdtempSync(shortTemp("plbs-"));
};

export const cleanupHome = () => {
  rmSync(home, { recursive: true, force: true });
};

/** The throwaway home's local-socket endpoint path. */
export const endpoint = () => localEndpoint(home);

export const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export const bytes = (n: number, seed: number) => {
  const out = new Uint8Array(n);

  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) % 256;

  return out;
};

export const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;

  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }

  return out;
};

export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

/** Polls `probe` for up to two seconds. */
export const eventually = (probe: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !probe(); i++) yield* Effect.sleep("10 millis");

    return probe();
  });

/** A loopback TCP server, closed with the scope; `connections` counts opens and closes. */
export const tcpServer = (onConnection: (socket: Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<{
      port: number;
      connections: { opened: number; closed: number };
      server: Server;
    }>((resume) => {
      const connections = { opened: 0, closed: 0 };

      const server = createServer((socket) => {
        connections.opened++;
        socket.on("close", () => connections.closed++);
        socket.on("error", () => {});
        onConnection(socket);
      });

      server.listen(0, "127.0.0.1", () => {
        // SAFETY: a TCP server listening on a numeric port reports an AddressInfo, not a path or null.
        const address = server.address() as AddressInfo;
        resume(Effect.succeed({ port: address.port, connections, server }));
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      })
  );

export const echoServer = tcpServer((socket) => {
  socket.pipe(socket);
});

/** A Daemon with the byte-stream handlers; `hosting` is the same service the handlers use. */
export const daemon = (
  options: { readonly quota?: number; readonly acceptTimeout?: Duration.Input } = {}
) =>
  Effect.gen(function* () {
    const found: Array<BrowserHosting["Service"]> = [];

    const handlers = Layer.merge(
      ByteStreamRpcsLive,
      Layer.effectDiscard(Effect.map(BrowserHosting, (hosting) => found.push(hosting)))
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          HostAddressStreams.layer,
          BrowserHosting.layer(
            options.acceptTimeout === undefined ? {} : { acceptTimeout: options.acceptTimeout }
          )
        ).pipe(Layer.provideMerge(ByteStreamQuota.layer(options.quota)))
      )
    );

    const server = yield* startServer({
      socketPath: localEndpoint(home),
      lockPath: join(home, "daemon.lock"),
      root: home,
      handlers,
      capabilities: ["host-address", "browser.host"],
    });

    const hosting = found[0];

    if (hosting === undefined) throw new Error("the handlers never saw BrowserHosting");

    return { server, hosting };
  });

export const CLIENT_CAPABILITIES: ReadonlyArray<Capability> = [
  "blobs",
  "host-address",
  "browser.host",
];

const fastPolicy = {
  initialDelayMs: 20,
  maxDelayMs: 200,
  needsAttentionRetryMs: 100,
  restartGraceMs: 5_000,
  helloTimeoutMs: 5_000,
};

/** A Client over the local socket or through `polaris bridge`; answers its live session. */
export const client = (
  transport: "socket" | "bridge",
  options: { readonly key?: string; readonly capabilities?: ReadonlyArray<Capability> } = {}
) =>
  Effect.gen(function* () {
    const identity = {
      name: "polaris-test",
      version: "0.0.0",
      deviceLabel: options.key ?? transport,
      capabilities: options.capabilities ?? CLIENT_CAPABILITIES,
    };

    const base = {
      key: options.key ?? transport,
      name: options.key ?? transport,
      identity,
      policy: fastPolicy,
    };

    const connection = yield* transport === "socket"
      ? makeHostConnection({
          ...base,
          target: HostTarget.Local({ socketPath: localEndpoint(home) }),
        })
      : makeHostConnection({
          ...base,
          target: HostTarget.Ssh({ alias: "unused" }),
          connector: spawnTransport(["bun", MAIN, "bridge"], {
            env: { ...process.env, POLARIS_HOME: home },
          }),
        });

    return yield* connection.awaitSession;
  });

/**
 * A Client over a node socket we can destroy to simulate a hard connection drop: no graceful
 * close runs, so the Daemon never sees a clean end for the streams it hosts there.
 */
export const hardConnection = Effect.fnUntraced(function* () {
  const socket = yield* Effect.acquireRelease(
    Effect.callback<Socket, Error>((resume) => {
      const connecting = netConnect(localEndpoint(home));
      connecting.once("connect", () => resume(Effect.succeed(connecting)));
      connecting.once("error", (error) => resume(Effect.fail(error)));
    }),
    (socket) => Effect.sync(() => socket.destroy())
  );

  const connection = yield* connectRpc({
    incoming: readEvents(socket),
    write: writeEvents(socket),
    close: Effect.sync(() => socket.end()),
  });

  const hello = yield* connection.client.hello({
    clientName: "test",
    clientVersion: "0",
    deviceLabel: "dropping",
    capabilities: CLIENT_CAPABILITIES,
  });

  const session: ByteStreamSession = {
    client: connection.client,
    blobs: connection.blobs,
    capabilities: hello.capabilities,
  };

  return { session, drop: () => socket.destroy() };
});

/** Writes `payload` and collects what comes back until `payload.byteLength` bytes, then closes. */
export const roundTrip = (
  transport: {
    incoming: Stream.Stream<Uint8Array, unknown>;
    write: (bytes: Uint8Array) => Effect.Effect<void, unknown>;
  },
  payload: Uint8Array
) =>
  Effect.gen(function* () {
    let total = 0;

    const received = yield* Effect.forkChild(
      transport.incoming.pipe(
        Stream.takeUntil((chunk) => {
          total += chunk.byteLength;

          return total >= payload.byteLength;
        }),
        Stream.runCollect
      )
    );

    yield* transport.write(payload);

    return concat(yield* Fiber.join(received));
  });

export const collectAll = (incoming: Stream.Stream<Uint8Array, unknown>) =>
  incoming.pipe(
    Stream.runFold(
      () => 0,
      (n, chunk) => n + chunk.byteLength
    )
  );
