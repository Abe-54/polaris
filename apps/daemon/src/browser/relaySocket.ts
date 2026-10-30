/**
 * One agent's WebSocket on the CDP relay (ENG-616): its text frames become delimited messages
 * on the session's `cdp` Browser stream and back. `Polaris.*` messages are the relay's own
 * (`README.md`) and never reach the agent. Without a Desktop App every command fails with
 * `NO_DESKTOP_APP_MESSAGE` and the socket closes.
 */
import {
  type ByteTransport,
  type CdpMessage,
  CdpMessageDecoder,
  encodeCdpMessage,
  NO_DESKTOP_APP_MESSAGE,
  type NoDesktopApp,
  parseCdpMessage,
  type SessionId,
} from "@polaris/protocol";
import type { ServerWebSocket } from "bun";
import {
  type Cause,
  Effect,
  Fiber,
  Latch,
  Option,
  Predicate,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect";
import type { BrowserStreamRefused } from "./hosting.ts";
import { RememberedTab } from "./relayStore.ts";

/** Close codes the relay sends (RFC 6455 §7.4.1). */
export const CLOSE_NORMAL = 1000;

export const CLOSE_UNSUPPORTED_DATA = 1003;

export const CLOSE_POLICY = 1008;

export const CLOSE_TOO_LARGE = 1009;

export const CLOSE_ERROR = 1011;

export const CLOSE_TRY_AGAIN_LATER = 1013;

/** Messages the relay queues for the Desktop App before it closes a flooding agent. */
export const RELAY_MAX_QUEUED_MESSAGES = 256;

/** Commands (and their bytes) held while the Browser stream opens, before the agent is closed. */
export const RELAY_MAX_PENDING_MESSAGES = 64;

export const RELAY_MAX_PENDING_BYTES = 1024 * 1024;

export interface RelaySocketHooks {
  readonly open: (
    sessionId: SessionId
  ) => Effect.Effect<ByteTransport, NoDesktopApp | BrowserStreamRefused, Scope.Scope>;
  readonly remembered: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<RememberedTab>>;
  readonly remember: (
    sessionId: SessionId,
    tabs: ReadonlyArray<RememberedTab>
  ) => Effect.Effect<void>;
  /** The socket is open and relaying, or waiting to refuse; false refuses it (too many). */
  readonly opened: (socket: RelaySocket) => boolean;
  /** The socket is gone, whoever closed it. */
  readonly closed: (socket: RelaySocket) => void;
}

export interface RelaySocketData {
  readonly sessionId: SessionId;
  relay: RelaySocket | null;
}

const TabsReport = Schema.Struct({ tabs: Schema.Array(RememberedTab) });

const decodeTabsReport = Schema.decodeUnknownOption(TabsReport);

const errorReply = (id: CdpMessage["id"], message: string): CdpMessage => ({
  id: id ?? null,
  error: { code: -32000, message },
});

export class RelaySocket {
  /** Commands that arrived before the Browser stream opened; null once it opened or refused. */
  private pending: Array<CdpMessage> | null = [];
  private pendingBytes = 0;
  private refusedWith: string | null = null;
  private admitted = false;
  private fiber: Fiber.Fiber<void, never> | null = null;
  private done = false;
  private readonly drained = Latch.makeUnsafe(true);
  readonly toDesktop = Effect.runSync(
    Queue.make<Uint8Array, Cause.Done>({
      capacity: RELAY_MAX_QUEUED_MESSAGES,
      strategy: "dropping",
    })
  );

  constructor(
    readonly sessionId: SessionId,
    private readonly socket: ServerWebSocket<RelaySocketData>,
    readonly hooks: RelaySocketHooks
  ) {}

  /** Opens the Browser stream and relays until either side closes. */
  start(): void {
    if (!this.hooks.opened(this)) {
      this.done = true;
      this.socket.close(CLOSE_TRY_AGAIN_LATER, "too many connections");

      return;
    }

    this.admitted = true;
    this.fiber = Effect.runFork(relayLoop(this));
  }

  /** A frame from the agent. */
  message(data: string | Buffer): void {
    if (!Predicate.isString(data)) {
      this.close(CLOSE_UNSUPPORTED_DATA, "text frames only");

      return;
    }

    const message = parseCdpMessage(data);

    if (message === null) {
      this.socket.send(JSON.stringify(errorReply(null, "Message must be a CDP message")));

      return;
    }

    if (message.method?.startsWith("Polaris.") === true) {
      this.socket.send(JSON.stringify(errorReply(message.id ?? null, "Polaris.* is reserved")));

      return;
    }

    if (this.pending !== null) {
      this.pendingBytes += data.length;

      if (
        this.pending.length >= RELAY_MAX_PENDING_MESSAGES ||
        this.pendingBytes > RELAY_MAX_PENDING_BYTES
      )
        this.close(CLOSE_TOO_LARGE, "input buffer full");
      else this.pending.push(message);
    } else if (this.refusedWith !== null) this.refuse([message], this.refusedWith);
    else this.forward(message);
  }

  /** The Browser stream is open: queued commands go through, and later ones directly. */
  opened(): void {
    const pending = this.pending ?? [];
    this.pending = null;
    pending.forEach((message) => this.forward(message));
  }

  /** No Browser stream: queued commands fail with `reason`, as every later one will. */
  refusedBy(reason: string): void {
    const pending = this.pending ?? [];
    this.pending = null;
    this.refusedWith = reason;
    this.refuse(pending, reason);
  }

  /** A message for the agent; waits while Bun holds an earlier send under backpressure. */
  sendToAgent(message: CdpMessage): Effect.Effect<void> {
    return Effect.andThen(this.drained.await, () =>
      Effect.sync(() => {
        if (this.done) return;
        const status = this.socket.send(JSON.stringify(message));

        // -1: queued under backpressure; the next send waits for `drain`. 0: dropped, the socket is gone.
        if (status === -1) this.drained.closeUnsafe();
        else if (status === 0) this.end();
      })
    );
  }

  /** Bun drained the queued send: the next message may go. */
  drain(): void {
    this.drained.openUnsafe();
  }

  /** The agent closed, or the socket dropped. */
  peerClosed(): void {
    this.end();
  }

  /** The session's token was revoked, the stream ended, or the Daemon stops. */
  close(code: number, reason: string): void {
    if (this.done) return;
    this.socket.close(code, reason);
    this.end();
  }

  private forward(message: CdpMessage): void {
    if (!Queue.offerUnsafe(this.toDesktop, encodeCdpMessage(message)))
      this.close(CLOSE_TOO_LARGE, "input buffer full");
  }

  private refuse(messages: ReadonlyArray<CdpMessage>, reason: string): void {
    for (const message of messages)
      this.socket.send(JSON.stringify(errorReply(message.id, reason)));

    if (messages.length > 0) this.close(CLOSE_ERROR, reason);
  }

  private end(): void {
    if (this.done) return;
    this.done = true;
    Queue.endUnsafe(this.toDesktop);
    this.drained.openUnsafe();

    if (this.fiber !== null) Effect.runFork(Fiber.interrupt(this.fiber));

    if (this.admitted) this.hooks.closed(this);
  }
}

/** A message from the Desktop App: the relay's own, or the agent's. */
const deliver = (socket: RelaySocket, message: CdpMessage): Effect.Effect<void> => {
  if (message.method === undefined || !message.method.startsWith("Polaris."))
    return socket.sendToAgent(message);

  if (message.method !== "Polaris.tabs") return Effect.void;
  const report = decodeTabsReport(message.params);

  return Option.isSome(report)
    ? socket.hooks.remember(socket.sessionId, report.value.tabs)
    : Effect.void;
};

const relayLoop = (socket: RelaySocket): Effect.Effect<void> => {
  const { hooks, sessionId } = socket;

  const opened = hooks.open(sessionId).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      NoDesktopApp: () => Effect.succeed(Option.none<ByteTransport>()),
      BrowserStreamRefused: () => Effect.succeed(Option.none<ByteTransport>()),
    })
  );

  return Effect.gen(function* () {
    const transport = yield* opened;

    if (Option.isNone(transport)) {
      socket.refusedBy(NO_DESKTOP_APP_MESSAGE);

      return yield* Effect.never;
    }

    socket.opened();
    const tabs = yield* hooks.remembered(sessionId);
    yield* transport.value.write(encodeCdpMessage({ method: "Polaris.hello", params: { tabs } }));
    const decoder = new CdpMessageDecoder();

    const toAgent = transport.value.incoming.pipe(
      Stream.mapEffect((chunk) => Effect.try(() => decoder.feed(chunk))),
      Stream.runForEach((messages) => Effect.forEach(messages, (m) => deliver(socket, m)))
    );

    const toDesktop = Stream.fromQueue(socket.toDesktop).pipe(
      Stream.runForEach((bytes) => transport.value.write(bytes))
    );

    yield* Effect.raceFirst(toAgent, toDesktop);
  }).pipe(
    Effect.scoped,
    Effect.catchCause(() =>
      Effect.sync(() => socket.close(CLOSE_ERROR, "the Browser stream failed"))
    ),
    Effect.ensuring(Effect.sync(() => socket.close(CLOSE_NORMAL, "closed")))
  );
};
