/**
 * `Bun.listen` / `Bun.connect({ fd })` sockets as ByteTransports.
 *
 * The Daemon listens with `Bun.listen` rather than `node:net` so the same
 * handlers serve fresh connections and the ones adopted from the previous
 * image during an execve upgrade (`connectFd` in `service/upgrade.ts`; Bun
 * cannot wrap an fd with `node:net`). Bun's `write` may accept only part of a
 * chunk; the rest is queued and flushed on `drain`.
 */
import { EventEmitter } from "node:events";
import { type ByteTransport, readEvents, writeEvents } from "@polaris/protocol";
import type { SocketHandler } from "bun";
import { Effect, Exit, type Scope } from "effect";

type Callback = (error?: Error | null) => void;

/** How long a graceful `end` waits for a stuck peer to drain before it force-terminates. */
const DRAIN_LIMIT_MS = 10_000;

/** The subset of a Bun `Socket` a stream drives; the real `Socket` satisfies it structurally. */
export interface SocketLike {
  write(bytes: Uint8Array): number;
  end(): void;
  terminate(): void;
  pause(): void;
  resume(): void;
}

export class BunSocketStream extends EventEmitter {
  destroyed = false;
  writable = true;
  private pending: Array<{ bytes: Uint8Array; callback: Callback }> = [];
  private endAfterFlush = false;
  private drainDeadline: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly socket: SocketLike) {
    super();
  }

  write(chunk: Uint8Array, callback: Callback): boolean {
    if (this.pending.length > 0) {
      this.pending.push({ bytes: chunk, callback });

      return false;
    }

    const written = this.socket.write(chunk);

    if (written >= chunk.byteLength) {
      queueMicrotask(() => callback());

      return true;
    }

    if (written < 0) {
      queueMicrotask(() => callback(new Error("socket closed")));

      return false;
    }

    this.pending.push({ bytes: chunk.subarray(written), callback });

    return false;
  }

  /** Called on `drain`: push out what `write` could not. */
  flush(): void {
    while (this.pending.length > 0) {
      const head = this.pending[0]!;
      const written = this.socket.write(head.bytes);

      if (written < 0) return;

      if (written < head.bytes.byteLength) {
        head.bytes = head.bytes.subarray(written);

        return;
      }

      this.pending.shift();
      head.callback();
    }

    this.clearDrainDeadline();

    if (this.endAfterFlush) this.socket.end();
    this.emit("drain");
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  private clearDrainDeadline(): void {
    if (this.drainDeadline === undefined) return;
    clearTimeout(this.drainDeadline);
    this.drainDeadline = undefined;
  }

  end(): void {
    this.writable = false;

    if (this.pending.length === 0) {
      this.socket.end();

      return;
    }

    // Wait for a stuck peer to drain, but not forever: force-terminate if it never does.
    this.endAfterFlush = true;
    this.drainDeadline ??= setTimeout(() => this.terminate(), DRAIN_LIMIT_MS);
    this.drainDeadline.unref?.();
  }

  /** Abrupt close (a disconnect or a cancelled scope): drop what is queued and reset the socket. */
  terminate(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.clearDrainDeadline();
    const pending = this.pending;
    this.pending = [];

    for (const { callback } of pending) callback(new Error("socket terminated"));
    this.socket.terminate();
    this.emit("end");
    this.emit("close");
  }

  closed(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.clearDrainDeadline();
    const pending = this.pending;
    this.pending = [];

    for (const { callback } of pending) callback(error ?? new Error("socket closed"));
    this.emit("end");
    this.emit("close");
  }
}

export const toTransport = (stream: BunSocketStream): ByteTransport => ({
  incoming: readEvents(stream),
  write: writeEvents(stream),
  close: Effect.sync(() => stream.end()),
});

/** Socket handlers that hand every opened connection to `onOpen` as a `BunSocketStream`. */
export const streamHandlers = (
  onOpen: (stream: BunSocketStream) => void
): SocketHandler<BunSocketStream | undefined> => ({
  binaryType: "uint8array",
  open(socket) {
    const stream = new BunSocketStream(socket);
    socket.data = stream;
    onOpen(stream);
  },
  data(socket, data) {
    socket.data?.emit("data", data);
  },
  drain(socket) {
    socket.data?.flush();
  },
  end(socket) {
    socket.data?.emit("end");
  },
  close(socket, error) {
    socket.data?.closed(error);
  },
  error(socket, error) {
    socket.data?.emit("error", error);
  },
});

/**
 * Socket handlers that turn every opened connection into a ByteTransport. The
 * transport's reader is attached in `open`, before any data can arrive.
 */
export const socketHandlers = (
  onConnection: (transport: ByteTransport) => void
): SocketHandler<BunSocketStream | undefined> =>
  streamHandlers((stream) => onConnection(toTransport(stream)));

/** How a loopback connect failed, in `HostAddressFailure`'s terms. */
export type ConnectFailureKind = "refused" | "unreachable" | "timeout";

export class LoopbackConnectError extends Error {
  constructor(
    readonly kind: ConnectFailureKind,
    message: string
  ) {
    super(message);
  }
}

const connectFailureKind = (error: Error): ConnectFailureKind => {
  // SAFETY: a socket connect error is a Node ErrnoException; its `code` is the errno name or undefined.
  const code = (error as NodeJS.ErrnoException).code ?? "";

  if (code === "ECONNREFUSED") return "refused";

  if (code === "ETIMEDOUT" || error.message.toLowerCase().includes("timed out")) return "timeout";

  return "unreachable";
};

/**
 * A TCP connection to `address:port` as a ByteTransport, closed with the scope. `address` is a
 * loopback literal the caller already validated; nothing here resolves a name.
 */
export const connectTcp = (
  address: string,
  port: number
): Effect.Effect<ByteTransport, LoopbackConnectError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<BunSocketStream, LoopbackConnectError>((resume) => {
      void Bun.connect<BunSocketStream | undefined>({
        hostname: address,
        port,
        socket: {
          ...streamHandlers((stream) => resume(Effect.succeed(stream))),
          connectError(_socket, error) {
            resume(Effect.fail(new LoopbackConnectError(connectFailureKind(error), error.message)));
          },
        },
      }).catch(() => {
        // `connectError` already settled the callback; the rejection is the same failure.
      });
    }),
    // A graceful end drains (bounded) so queued bytes still reach the peer; a cancel, disconnect
    // or error terminates, so a stuck peer can't pin the socket.
    (stream, exit) => Effect.sync(() => (Exit.isSuccess(exit) ? stream.end() : stream.terminate()))
  ).pipe(Effect.map(toTransport));
