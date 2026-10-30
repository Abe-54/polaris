/**
 * The Daemon's socket to the Polaris Relay (apps/relay/README.md is the contract):
 * proves the Host's relay key, declares its peers on every connect and whenever they
 * change, accepts Linked Devices' handshakes and carries their sessions. It reconnects
 * with backoff and full jitter; while connected and idle it sends nothing (the relay pings).
 */
import {
  decodeDataFrame,
  decodeRelayControl,
  encodeControl,
  encodeDataFrame,
  fromBase64Url,
  type Live,
  type LiveGone,
  RelayAddress,
  type RelayControl,
  type RelayLimits,
  RelayOp,
  toBase64Url,
  type Wake,
  type WakeOutcome,
} from "@polaris/protocol/relay";
import {
  acceptHandshake,
  proveRelayKey,
  readRecord,
  RecordType,
  type RelayIdentity,
  type RelaySession,
  type StaticKeyPair,
} from "@polaris/protocol/relay/party";
import { Match, Option, Predicate, Schema } from "effect";
import { Pacer } from "./pacer.ts";
import { DeviceSession } from "./session.ts";

const BACKOFF_MIN_MS = 500;

const BACKOFF_MAX_MS = 30_000;

/** How long a wake waits for the relay's `woken` before it counts as unavailable. */
const WAKE_TIMEOUT_MS = 20_000;

/** Bun's WebSocket buffers what the network can't take yet; writers wait above this. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** What a handshake from `source` is, decided by the Linked Devices and the open links. */
export type Admission =
  | { readonly kind: "device"; readonly deviceId: string }
  | { readonly kind: "link"; readonly complete: () => void }
  | null;

export interface RelayLinkOptions {
  readonly url: string;
  readonly identity: RelayIdentity;
  readonly noise: StaticKeyPair;
  /** The relay addresses the Host links right now: devices and open links. */
  readonly peers: () => ReadonlyArray<RelayAddress>;
  /** Decides a proven handshake. Called synchronously before any reply is sent. */
  readonly admit: (source: RelayAddress, deviceKey: Uint8Array, payload: Uint8Array) => Admission;
  /** A device's new session: the Daemon serves a connection over it. */
  readonly serve: (session: DeviceSession, deviceId: string) => void;
  /** A device's session ended, whoever ended it. */
  readonly ended?: (session: DeviceSession) => void;
  readonly onConnectedChange: (connected: boolean) => void;
  /** The relay says a Live Activity's token is gone (`live-gone`). */
  readonly onLiveGone?: (gone: typeof LiveGone.Type) => void;
  readonly log: (message: string) => void;
  /** For tests: a fixed backoff instead of the jittered one. */
  readonly backoff?: (attempt: number) => number;
}

const jittered = (attempt: number) =>
  Math.random() * Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);

const decodeAddress = Schema.decodeUnknownOption(RelayAddress);

/** A WebSocket message as the socket hands it over: text, or binary as an ArrayBuffer. */
const decodeMessage = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.instanceOf(ArrayBuffer)])
);

interface Decision {
  admission: Admission;
}

export class RelayLink {
  private ws: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pacer: Pacer | null = null;
  private readonly sessions = new Map<RelayAddress, DeviceSession>();
  /** The relay announced a push service in its challenge on this socket. */
  private push = false;
  private nextWake = 0;
  private readonly wakes = new Map<string, (outcome: WakeOutcome) => void>();

  constructor(private readonly options: RelayLinkOptions) {
    this.connect();
  }

  get connected(): boolean {
    return this.ready;
  }

  /** Sends the current peers; on a socket not yet ready, `auth` will carry them. */
  peersChanged(): void {
    if (this.ready) this.sendText(encodeControl({ t: "peers", peers: [...this.options.peers()] }));
  }

  /**
   * Asks the relay to wake a device through APNs. Nothing is queued: without a ready socket
   * to a relay with push, or without an answer in time, the wake is `unavailable`.
   */
  wake(request: Omit<Wake, "t" | "id">): Promise<WakeOutcome> {
    if (!this.ready || !this.push) return Promise.resolve("unavailable");
    const id = `w${(this.nextWake++).toString(36)}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settleWake(id, "unavailable"), WAKE_TIMEOUT_MS);

      this.wakes.set(id, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
      this.sendText(encodeControl({ t: "wake", id, ...request }));
    });
  }

  /** Sends this Host's slice of a Live Activity; false without a ready socket to a relay with push. */
  live(frame: Omit<Live, "t">): boolean {
    if (!this.ready || !this.push) return false;
    this.sendText(encodeControl({ t: "live", ...frame }));

    return true;
  }

  private settleWake(id: string, outcome: WakeOutcome): void {
    const settle = this.wakes.get(id);
    this.wakes.delete(id);
    settle?.(outcome);
  }

  /** Ends the session of the device at `peer`, if it has one (unlink, presence, replace). */
  drop(peer: RelayAddress): void {
    this.sessions.get(peer)?.end();
  }

  /** Closes the socket and every session for good. */
  stop(): void {
    this.stopped = true;

    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close(1000, "relay route off");
    this.disconnected();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.options.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const data = Option.getOrNull(decodeMessage(event.data));

      if (this.ws === ws && data !== null) this.onMessage(data);
    });
    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.options.log(`the relay socket closed (${event.code})`);
      this.ws = null;
      this.disconnected();
      this.reconnectLater(event.code);
    });
  }

  private reconnectLater(code: number): void {
    if (this.stopped) return;
    // Replaced by a newer socket with this key: another Daemon holds the Host's key; back off fully.
    const attempt = code === 4409 ? 16 : this.attempt++;
    const delay = this.options.backoff?.(attempt) ?? jittered(attempt);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  /** Every session ends with the socket: devices handshake again after a reconnect. */
  private disconnected(): void {
    for (const session of this.sessions.values()) session.end();

    for (const id of this.wakes.keys()) this.settleWake(id, "unavailable");
    this.push = false;

    if (this.ready) {
      this.ready = false;
      this.options.onConnectedChange(false);
    }
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (Predicate.isString(data)) {
      Option.match(decodeRelayControl(data), {
        onNone: () => this.options.log("ignoring a control message this Daemon doesn't know"),
        onSome: (message) => this.onControl(message),
      });

      return;
    }

    this.onData(new Uint8Array(data));
  }

  private onControl(message: RelayControl): void {
    Match.value(message).pipe(
      Match.discriminatorsExhaustive("t")({
        challenge: (challenge) => {
          this.push = challenge.push === true;
          this.authenticate(challenge.nonce, challenge.limits);
        },
        ready: () => {
          this.ready = true;
          this.attempt = 0;
          this.options.onConnectedChange(true);
        },
        presence: ({ peer, online }) => {
          if (!online) this.drop(peer);
        },
        unreachable: () => undefined,
        woken: ({ id, outcome }) => this.settleWake(id, outcome),
        "live-gone": (gone) => this.options.onLiveGone?.(gone),
      })
    );
  }

  private authenticate(nonce: string, limits: RelayLimits): void {
    const bytes = fromBase64Url(nonce);

    if (Option.isNone(bytes)) {
      this.ws?.close(1000, "bad challenge");

      return;
    }

    this.pacer = new Pacer(limits);

    this.sendText(
      encodeControl({
        t: "auth",
        role: "host",
        key: toBase64Url(this.options.identity.publicKey),
        sig: toBase64Url(proveRelayKey(this.options.identity, bytes.value, "host")),
        peers: [...this.options.peers()],
      })
    );
  }

  private onData(bytes: Uint8Array): void {
    const frame = Option.getOrNull(decodeDataFrame(bytes));

    if (frame === null || frame.op !== RelayOp.Forward) return;
    const source = Option.getOrNull(decodeAddress(frame.peer));

    if (source === null) return;
    let record: ReturnType<typeof readRecord>;

    try {
      record = readRecord(frame.payload);
    } catch {
      return;
    }

    if (record.type === RecordType.Init) this.onInit(source, frame.payload);
    else if (record.type === RecordType.Data) this.onRecord(source, record.tag, frame.payload);
  }

  private onRecord(source: RelayAddress, tag: Uint8Array, record: Uint8Array): void {
    const session = this.sessions.get(source);

    if (session === undefined || !sameTag(session.tag, tag)) return;
    session.receive(record);
  }

  private onInit(source: RelayAddress, init: Uint8Array): void {
    const decided: Decision = { admission: null };
    let accepted: { session: RelaySession; reply: Uint8Array };

    try {
      accepted = acceptHandshake(this.options.noise, init, (deviceKey, payload) => {
        decided.admission = this.options.admit(source, deviceKey, payload);

        return decided.admission !== null;
      });
    } catch {
      // Unknown or unlinked keys get no reply at all.
      return;
    }

    const admitted = decided.admission;

    if (admitted === null) return;
    const replied = this.sendRecords(source, [accepted.reply]);

    if (admitted.kind === "link") {
      // The link's address leaves the peers once it is used: only after the reply went out.
      replied.then(admitted.complete, () => undefined);

      return;
    }

    replied.catch(() => undefined);

    this.sessions.get(source)?.end();

    const session = new DeviceSession(source, accepted.session, {
      send: (peer, records) => this.sendRecords(peer, records),
      ended: (ended) => {
        if (this.sessions.get(ended.peer) === ended) this.sessions.delete(ended.peer);
        this.options.ended?.(ended);
      },
    });

    this.sessions.set(source, session);
    this.options.serve(session, admitted.deviceId);
  }

  private sendText(text: string): void {
    this.ws?.send(text);
  }

  private sendRecords(peer: RelayAddress, records: ReadonlyArray<Uint8Array>): Promise<void> {
    const ws = this.ws;
    const pacer = this.pacer;

    if (ws === null || pacer === null || !this.ready)
      return Promise.reject(new Error("the relay socket is not ready"));

    const frames = records.map((record) => encodeDataFrame(RelayOp.Forward, peer, record));

    return pacer
      .enqueue(frames, (frame) => {
        if (this.ws !== ws) throw new Error("the relay socket closed");
        ws.send(frame);
      })
      .then(() => drained(ws));
  }
}

const sameTag = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

/** Waits while Bun's socket holds more than MAX_BUFFERED_BYTES unsent. */
const drained = async (ws: WebSocket): Promise<void> => {
  while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > MAX_BUFFERED_BYTES)
    await Bun.sleep(10);
};
