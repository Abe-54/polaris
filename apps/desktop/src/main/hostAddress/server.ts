/**
 * The HTTP proxy a remote Host's Browser partitions use, on 127.0.0.1 at an ephemeral port.
 * Every request must carry the proxy's per-launch secret. A Host address becomes a
 * Host-address stream on that Host's connection, its hostname unresolved.
 */
import { randomBytes } from "node:crypto";
import { lookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import {
  BlockList,
  connect,
  createServer,
  type AddressInfo,
  type LookupFunction,
  type Server,
  type Socket,
} from "node:net";
import { Effect, Fiber, Scope, Stream } from "effect";
import {
  authorized,
  Head,
  isIpLiteral,
  parseRequest,
  proxyCredential,
  ProxyRequest,
  proxyChallenge,
  proxyResponse,
  ResponseScreen,
  screenResponse,
  type ProxyStatus,
  splitHead,
  TUNNEL_ESTABLISHED,
} from "./proxy.ts";

/** A Host-address stream once open: the Host's bytes, and a way to send it ours. */
export interface HostAddressTransport {
  readonly incoming: Stream.Stream<Uint8Array, unknown>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, unknown>;
}

export interface Target {
  readonly hostname: string;
  readonly port: number;
}

/** Opens a stream to `hostname:port` on the Host's loopback; fails with the status to answer. */
export type OpenHostAddress<R> = (
  target: Target
) => Effect.Effect<HostAddressTransport, ProxyStatus, Scope.Scope | R>;

export interface ProxyServerOptions<R> {
  readonly open: OpenHostAddress<R>;
  readonly isHostAddress: (hostname: string) => boolean;
  /** Runs one connection's stream; interrupted when its socket closes. */
  readonly run: (effect: Effect.Effect<void, never, R>) => Fiber.Fiber<void>;
  /** A direct connection for any other name; `net.connect` with `lookupOutside` by default. */
  readonly connectDirect?: (hostname: string, port: number) => Socket;
  /** How long a connection may take to send an authorized request; 10 s by default. */
  readonly handshakeTimeoutMs?: number | undefined;
  /** How long a direct connection may take to open; 10 s by default. */
  readonly connectTimeoutMs?: number | undefined;
  /** Connections beyond this are closed unread; 256 by default. */
  readonly maxConnections?: number | undefined;
}

export interface ProxyServer {
  readonly port: number;
  /** The password Electron's `login` event answers with, for this server only. */
  readonly secret: string;
  /** This server's challenge realm, random per launch; `login` answers only this one. */
  readonly realm: string;
  /**
   * Stops relaying: open connections end and new ones are closed unread. The port stays
   * held, so no other process can take it while partitions still point at it.
   */
  readonly retire: () => void;
  readonly close: () => Promise<void>;
}

type Route =
  | { readonly kind: "host"; readonly target: Target }
  | { readonly kind: "direct"; readonly target: Target }
  | { readonly kind: "refuse" };

/**
 * IP literals go to the Host only when they are loopback, and never directly from here;
 * other Host-address names go to the Host, and any other name loads directly.
 */
export const routeOf = (target: Target, isHostAddress: (name: string) => boolean): Route => {
  if (isHostAddress(target.hostname)) return { kind: "host", target };

  return isIpLiteral(target.hostname) ? { kind: "refuse" } : { kind: "direct", target };
};

/** Addresses that mean this machine; IPv4-mapped IPv6 as a whole, as names rarely map to it. */
const thisMachine = () => {
  const list = new BlockList();

  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  list.addSubnet("::ffff:0:0", 96, "ipv6");

  return list;
};

const THIS_MACHINE = thisMachine();

const outside = ({ address, family }: LookupAddress) =>
  !THIS_MACHINE.check(address, family === 6 ? "ipv6" : "ipv4");

/**
 * DNS for a direct connection, dropping addresses on this machine: a name that resolves to
 * loopback would otherwise reach the Client's own servers, never the Host's.
 */
export const lookupOutside = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: ReadonlyArray<LookupAddress>) => void
) =>
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    const usable = error === null ? addresses.filter(outside) : [];

    if (error !== null || usable.length > 0) return callback(error, usable);

    callback(Object.assign(new Error(`${hostname} is this machine`), { code: "ELOOPBACK" }), []);
  });

/** Node's lookup contract: every address when `all` is set, else the first. */
const directLookup: LookupFunction = (hostname, options, callback) =>
  lookupOutside(hostname, { ...options, all: true }, (error, addresses) => {
    const [first] = addresses;

    if (options.all === true) return callback(error, [...addresses]);

    callback(error, first?.address ?? "", first?.family ?? 4);
  });

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);

  out.set(a);
  out.set(b, a.length);

  return out;
};

/** Writes and waits until the socket can take more, so `incoming` is read no faster than it drains. */
const writeTo = (socket: Socket, chunk: Uint8Array) =>
  Effect.callback<void>((resume) => {
    if (socket.destroyed) return resume(Effect.void);

    if (socket.write(chunk)) return resume(Effect.void);

    const done = () => {
      socket.off("drain", done).off("close", done);
      resume(Effect.void);
    };

    socket.once("drain", done).once("close", done);
  });

/** The browser's bytes, at most `limit` of them when set; the stream then waits for the close. */
const upstream = (socket: Socket, limit: number | null) => {
  const bytes = Stream.fromAsyncIterable<Uint8Array, unknown>(socket, (error) => error);

  if (limit === null) return bytes;
  let left = limit;

  return bytes.pipe(
    Stream.takeWhile(() => left > 0),
    Stream.map((chunk) => {
      const kept = chunk.subarray(0, left);

      left -= kept.length;

      return kept;
    }),
    Stream.concat(Stream.never)
  );
};

/**
 * Both directions until the browser closes its side or either fails. When the Host's side
 * ends first, the socket half-closes and the browser's side drains.
 */
export const pipeTransport = (
  socket: Socket,
  transport: HostAddressTransport,
  rest: Uint8Array,
  limit: number | null = null
) => {
  const first = limit === null ? rest : rest.subarray(0, limit);

  const up = Effect.andThen(
    first.length === 0 ? Effect.void : transport.write(first),
    upstream(socket, limit === null ? null : limit - first.length).pipe(
      Stream.runForEach((chunk) => transport.write(chunk))
    )
  );

  const down = transport.incoming.pipe(
    Stream.runForEach((chunk) => writeTo(socket, chunk)),
    Effect.andThen(Effect.sync(() => socket.end())),
    Effect.andThen(Effect.never)
  );

  return Effect.raceFirst(up, down);
};

const DIRECT_FAILURES = new Map<string | undefined, ProxyStatus>([
  ["ELOOPBACK", 403],
  ["ETIMEDOUT", 504],
]);

/**
 * A name outside the Host addresses, as Chromium sends it when the bypass list misses it
 * (`printer2`): main's DNS and a TCP connection; TLS inside it stays Chromium's.
 */
/** Waits for the connection, interruptibly: a cancelled load stops waiting at once. */
const connected = (remote: Socket) =>
  Effect.callback<Socket, ProxyStatus>((resume) => {
    const failed = (error: NodeJS.ErrnoException) =>
      resume(Effect.fail(DIRECT_FAILURES.get(error.code) ?? 502));

    const ready = () => {
      remote.off("error", failed).on("error", () => remote.destroy());
      resume(Effect.succeed(remote));
    };

    remote.once("error", failed).once("connect", ready);

    return Effect.sync(() => remote.off("error", failed).off("connect", ready));
  });

const openDirect =
  (connectDirect: (hostname: string, port: number) => Socket, timeoutMs: number) =>
  ({ hostname, port }: Target): Effect.Effect<HostAddressTransport, ProxyStatus, Scope.Scope> =>
    // The socket's cleanup is registered before any wait, so an interrupt always destroys it.
    Effect.acquireRelease(
      Effect.sync(() => connectDirect(hostname, port)),
      (remote) => Effect.sync(() => remote.destroy())
    ).pipe(
      Effect.flatMap((remote) =>
        connected(remote).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail<ProxyStatus>(504),
          })
        )
      ),
      Effect.map((remote) => ({
        incoming: Stream.fromAsyncIterable<Uint8Array, unknown>(remote, (error) => error),
        write: (bytes: Uint8Array) => writeTo(remote, bytes),
      }))
    );

/** A screened piece of the response; `last` ends the relay after it. */
interface Screened {
  readonly bytes: Uint8Array;
  readonly last: boolean;
}

/** What's still held back of the response's heads; null once they've passed. */
type Held = Uint8Array | null;

const screened = (held: Held, chunk: Uint8Array): readonly [Held, ReadonlyArray<Screened>] => {
  if (held === null) return [null, [{ bytes: chunk, last: false }]];
  const head = concat(held, chunk);

  return ResponseScreen.$match(screenResponse(head), {
    NeedMore: () => [head, []] as const,
    Pass: ({ bytes }) => [null, [{ bytes, last: false }]] as const,
    Refuse: () => [null, [{ bytes: proxyResponse(502), last: true }]] as const,
  });
};

/**
 * A forwarded request's response, but a 407 from the Host, in any head through the final one,
 * becomes this proxy's 502 and ends there: relayed, Chromium would answer it with the secret.
 */
const refusingChallenges = (transport: HostAddressTransport): HostAddressTransport => ({
  ...transport,
  incoming: transport.incoming.pipe(
    Stream.mapAccum((): Held => new Uint8Array(), screened),
    Stream.takeUntil((piece) => piece.last),
    Stream.map((piece) => piece.bytes)
  ),
});

const answer = (socket: Socket, status: ProxyStatus) => {
  socket.end(proxyResponse(status));
};

/** What goes ahead of the browser's bytes: a 200 to the browser, or the request to the Host. */
interface Relay {
  readonly target: Target;
  readonly established: Uint8Array | null;
  readonly head: Uint8Array | null;
  readonly limit: number | null;
}

const relayOf = (request: ProxyRequest): Relay | null =>
  ProxyRequest.$match(request, {
    Tunnel: ({ hostname, port }): Relay => ({
      target: { hostname, port },
      established: TUNNEL_ESTABLISHED,
      head: null,
      limit: null,
    }),
    Forward: ({ hostname, port, head, body }): Relay => ({
      target: { hostname, port },
      established: null,
      head,
      limit: body,
    }),
    Invalid: () => null,
  });

function relay<R>(
  socket: Socket,
  request: ProxyRequest,
  rest: Uint8Array,
  options: ProxyServerOptions<R>
) {
  const relayed = relayOf(request);

  if (relayed === null) return answer(socket, 400);
  const route = routeOf(relayed.target, options.isHostAddress);

  if (route.kind === "refuse") return answer(socket, 403);

  const open =
    route.kind === "host"
      ? options.open
      : openDirect(
          options.connectDirect ?? ((host, port) => connect({ host, port, lookup: directLookup })),
          options.connectTimeoutMs ?? 10_000
        );

  const stream = open(route.target).pipe(
    Effect.matchEffect({
      onFailure: (status) => Effect.sync(() => answer(socket, status)),
      onSuccess: (transport) =>
        Effect.gen(function* () {
          if (relayed.established !== null) socket.write(relayed.established);

          if (relayed.head === null)
            return yield* pipeTransport(socket, transport, rest, relayed.limit);
          yield* transport.write(relayed.head);
          yield* pipeTransport(socket, refusingChallenges(transport), rest, relayed.limit);
        }),
    }),
    Effect.catchCause(() => Effect.void),
    Effect.scoped,
    Effect.ensuring(Effect.sync(() => socket.destroy()))
  );

  const fiber = options.run(stream);

  socket.once("close", () => Effect.runFork(Fiber.interrupt(fiber)));
}

/**
 * Reads the request head, however it is split, then checks the credential before anything
 * else in it: without the secret, the answer is a 407 and nothing is opened.
 */
function handshake<R>(
  socket: Socket,
  { credential, realm }: { readonly credential: Uint8Array; readonly realm: string },
  options: ProxyServerOptions<R>
) {
  let received: Uint8Array = new Uint8Array();

  socket.setTimeout(options.handshakeTimeoutMs ?? 10_000, () => socket.destroy());

  const onData = (chunk: Uint8Array) => {
    received = concat(received, chunk);

    Head.$match(splitHead(received), {
      NeedMore: () => undefined,
      TooLarge: () => socket.destroy(),
      Done: ({ lines, rest }) => {
        socket.off("data", onData);
        socket.setTimeout(0);

        if (!authorized(lines, credential)) return void socket.end(proxyChallenge(realm));
        socket.pause();
        relay(socket, parseRequest(lines), rest, options);
      },
    });
  };

  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
}

export const startProxyServer = <R>(options: ProxyServerOptions<R>): Promise<ProxyServer> =>
  new Promise((resolve, reject) => {
    const secret = randomBytes(32).toString("base64url");
    const credential = proxyCredential(secret);
    const realm = `Polaris ${randomBytes(12).toString("base64url")}`;
    const sockets = new Set<Socket>();
    const max = options.maxConnections ?? 256;

    let retired = false;

    const server: Server = createServer({ noDelay: true }, (socket) => {
      if (retired || sockets.size >= max) return void socket.destroy();
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      handshake(socket, { credential, realm }, options);
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a TCP server listening on a port reports an AddressInfo.
      const { port } = server.address() as AddressInfo;

      resolve({
        port,
        secret,
        realm,
        retire: () => {
          retired = true;

          for (const socket of sockets) socket.destroy();
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());

            for (const socket of sockets) socket.destroy();
          }),
      });
    });
  });
