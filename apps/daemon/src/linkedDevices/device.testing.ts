/**
 * A Linked Device for tests: dials the relay with its own relay identity, links with a
 * link string, and opens a session whose ByteTransport an RPC client speaks over, as
 * the Mobile App does. Also starts a real relay process (`apps/relay/src/main.ts`).
 */
import { join } from "node:path";
import {
  type ByteTransport,
  decodeLinkString,
  encodeLinkRequest,
  type LinkPayload,
  TransportError,
} from "@polaris/protocol";
import {
  decodeDataFrame,
  decodeRelayControl,
  encodeControl,
  encodeDataFrame,
  fromBase64Url,
  type RelayAddress,
  RelayOp,
  relayAddress,
  toBase64Url,
} from "@polaris/protocol/relay";
import {
  generateRelayIdentity,
  generateStaticKeyPair,
  linkIdentity,
  linkProof,
  proveRelayKey,
  RelayInitiator,
  type RelayIdentity,
  type RelaySession,
  type StaticKeyPair,
} from "@polaris/protocol/relay/party";
import { Cause, Effect, Option, Predicate, Queue, Stream } from "effect";

const WAIT_MS = 5_000;

const key = (text: string) => Option.getOrThrow(fromBase64Url(text));

/** One relay socket authenticated as a device; data frames from the host queue up. */
export class DeviceSocket {
  private readonly frames: Array<Uint8Array> = [];
  private waiter: (() => void) | null = null;
  readonly closed: Promise<number>;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    this.closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
    ws.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        const frame = Option.getOrThrow(decodeDataFrame(new Uint8Array(event.data)));
        this.frames.push(frame.payload.slice());
      }

      this.waiter?.();
    });
  }

  static async connect(url: string, identity: RelayIdentity): Promise<DeviceSocket> {
    const ws = new WebSocket(url);
    const socket = new DeviceSocket(ws);

    const challenge = await new Promise<string>((resolve, reject) => {
      ws.addEventListener("message", (event) => {
        if (!Predicate.isString(event.data)) return;
        const message = Option.getOrNull(decodeRelayControl(event.data));

        if (message?.t === "challenge") resolve(message.nonce);
      });
      ws.addEventListener("close", () => reject(new Error("relay closed before the challenge")));
    });

    const ready = new Promise<void>((resolve) =>
      ws.addEventListener("message", (event) => {
        if (Predicate.isString(event.data) && event.data.includes('"ready"')) resolve();
      })
    );

    ws.send(
      encodeControl({
        t: "auth",
        role: "device",
        key: toBase64Url(identity.publicKey),
        sig: toBase64Url(proveRelayKey(identity, key(challenge), "device")),
      })
    );
    await ready;

    return socket;
  }

  send(peer: RelayAddress, record: Uint8Array): void {
    this.ws.send(encodeDataFrame(RelayOp.Forward, peer, record));
  }

  /** The next record from the host, or null after `ms` without one. */
  async next(ms = WAIT_MS): Promise<Uint8Array | null> {
    const deadline = Date.now() + ms;

    while (this.frames.length === 0) {
      if (Date.now() > deadline || this.ws.readyState === WebSocket.CLOSED) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, 25);
      });
    }

    return this.frames.shift() ?? null;
  }

  close(): void {
    this.ws.close();
  }
}

export interface TestDevice {
  readonly identity: RelayIdentity;
  readonly address: RelayAddress;
  readonly noise: StaticKeyPair;
}

export const makeDevice = async (): Promise<TestDevice> => {
  const identity = generateRelayIdentity();

  return {
    identity,
    address: await relayAddress(identity.publicKey),
    noise: generateStaticKeyPair(),
  };
};

/** Handshakes with the host; null when the host never replies (refused). */
export const handshake = async (
  socket: DeviceSocket,
  host: { readonly address: RelayAddress; readonly noiseKey: Uint8Array },
  noise: StaticKeyPair,
  payload?: Uint8Array,
  tries = 4
): Promise<RelaySession | null> => {
  // The host may not be online yet right after a reconnect: retry, ignoring stale replies.
  for (let attempt = 0; attempt < tries; attempt++) {
    const initiator = new RelayInitiator(noise, host.noiseKey, payload);
    socket.send(host.address, initiator.init);
    const deadline = Date.now() + 1_000;

    for (
      let reply = await socket.next(1_000);
      reply !== null;
      reply = await socket.next(deadline - Date.now())
    ) {
      if (reply.subarray(1, 9).every((byte, i) => byte === initiator.tag[i]))
        return initiator.finish(reply);
    }
  }

  return null;
};

/** Links `device` with the link string's secret; true once the host answered. */
export const link = async (
  linkString: string,
  device: TestDevice,
  name: string,
  /** Proves with this secret instead of the link's, as a forger would. */
  proofSecret?: Uint8Array
) => {
  const payload: LinkPayload = Option.getOrThrow(decodeLinkString(linkString)).link;
  const secret = key(payload.secret);
  const socket = await DeviceSocket.connect(payload.relayUrl, linkIdentity(secret));

  const request = encodeLinkRequest({
    v: 1,
    address: device.address,
    name,
    proof: toBase64Url(linkProof(proofSecret ?? secret, device.noise.publicKey, device.address)),
  });

  const session = await handshake(
    socket,
    { address: payload.hostAddress, noiseKey: key(payload.hostNoiseKey) },
    device.noise,
    new TextEncoder().encode(request),
    2
  );

  socket.close();

  return { linked: session !== null, payload };
};

/** The session as a ByteTransport: what an RPC client writes is sealed for the host. */
export const sessionTransport = (
  socket: DeviceSocket,
  hostAddress: RelayAddress,
  session: RelaySession
): ByteTransport => {
  const queue = Effect.runSync(Queue.unbounded<Uint8Array, Cause.Done>());

  void (async () => {
    for (;;) {
      const record = await socket.next(60_000);

      if (record === null) break;

      try {
        Queue.offerUnsafe(queue, session.open(record));
      } catch {
        break;
      }
    }

    Queue.endUnsafe(queue);
  })();

  return {
    incoming: Stream.fromQueue(queue),
    write: (bytes) =>
      socket.ws.readyState === WebSocket.OPEN
        ? Effect.sync(() =>
            session.seal(bytes).forEach((record) => socket.send(hostAddress, record))
          )
        : Effect.fail(new TransportError({ message: "relay socket closed" })),
    close: Effect.sync(() => socket.close()),
  };
};

/** A free TCP port on loopback. */
export const freePort = (): number => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });

  const port = listener.port;
  listener.stop(true);

  return port;
};

/** Runs the real relay (`bun apps/relay/src/main.ts`) on `port` until `stop`. */
export const startRelay = async (port = freePort(), env: Readonly<Record<string, string>> = {}) => {
  const child = Bun.spawn(["bun", "src/main.ts"], {
    cwd: join(import.meta.dir, "../../../relay"),
    env: {
      ...process.env,
      PORT: String(port),
      POLARIS_RELAY_HOSTNAME: "127.0.0.1",
      POLARIS_RELAY_CONNECT_BURST_PER_IP: "200",
      ...env,
    },
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = child.stdout.getReader();
  let text = "";
  const logListeners = new Set<() => void>();
  const deadline = Date.now() + 10_000;

  while (!text.includes('"relay.start"')) {
    if (Date.now() > deadline) throw new Error("the relay did not start");
    const { value, done } = await reader.read();

    if (done) throw new Error("the relay exited");
    text += new TextDecoder().decode(value);
  }

  // Keep draining its log so the pipe never fills, and keep it for tests that read it.
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;
      text += new TextDecoder().decode(value);

      for (const listener of logListeners) listener();
    }
  })();

  return {
    port,
    /** Everything the relay logged so far. */
    log: () => text,
    /** Resolves when stdout contains the entry, within the existing ten-second wait budget. */
    waitForLog: (entry: string) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (!text.includes(entry)) return;
          clearTimeout(timer);
          logListeners.delete(check);
          resolve();
        };

        const timer = setTimeout(() => {
          logListeners.delete(check);
          reject(new Error(`timed out waiting for relay log entry ${entry}`));
        }, 10_000);

        logListeners.add(check);
        check();
      }),
    url: `ws://127.0.0.1:${port}/v1`,
    stop: async () => {
      child.kill("SIGTERM");
      await child.exited;
    },
  };
};
