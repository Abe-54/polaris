/**
 * A test party: a WebSocket client that proves its key to the relay and
 * exchanges records. It keeps every message it sent, so tests can check what
 * the relay was handed.
 */
import {
  type DataFrame,
  decodeDataFrame,
  decodeRelayControl,
  encodeControl,
  encodeDataFrame,
  fromBase64Url,
  type RelayAddress,
  type RelayControl,
  RelayOp,
  type RelayRole,
  toBase64Url,
} from "@polaris/protocol/relay";
import {
  generateRelayIdentity,
  proveRelayKey,
  type RelayIdentity,
} from "@polaris/protocol/relay/party";
import { Option, Predicate, Schema } from "effect";

const decodeMessageData = Schema.decodeUnknownSync(
  Schema.Union([Schema.String, Schema.instanceOf(ArrayBuffer)])
);

type Inbound =
  | { readonly kind: "control"; readonly message: RelayControl }
  | { readonly kind: "data"; readonly frame: DataFrame };

export interface Closed {
  readonly code: number;
  readonly reason: string;
}

const WAIT_MS = 3_000;

export class TestParty {
  readonly sent: Array<string | Uint8Array> = [];
  /** Every control message received, including those a wait already took. */
  readonly received: Array<RelayControl> = [];
  readonly closed: Promise<Closed>;
  private readonly inbox: Array<Inbound> = [];
  private waiter: (() => void) | null = null;
  address: RelayAddress | null = null;

  private constructor(
    readonly ws: WebSocket,
    readonly identity: RelayIdentity
  ) {
    ws.binaryType = "arraybuffer";
    this.closed = new Promise((resolve) =>
      ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }))
    );
    ws.addEventListener("message", (event) => {
      const inbound = TestParty.parse(decodeMessageData(event.data));

      if (inbound.kind === "control") this.received.push(inbound.message);
      this.inbox.push(inbound);
      this.waiter?.();
    });
  }

  /** Opens a socket and waits for the relay's challenge, without answering it. */
  static async open(url: string, identity = generateRelayIdentity()): Promise<TestParty> {
    const ws = new WebSocket(url);
    const party = new TestParty(ws, identity);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("relay refused the socket")));
    });

    return party;
  }

  /** Opens, proves the key as `role` and waits for `ready`. */
  static async connect(
    url: string,
    role: RelayRole,
    options: { identity?: RelayIdentity; peers?: ReadonlyArray<RelayAddress> } = {}
  ): Promise<TestParty> {
    const party = await TestParty.open(url, options.identity);
    await party.authenticate(role, options.peers);

    return party;
  }

  async authenticate(role: RelayRole, peers?: ReadonlyArray<RelayAddress>): Promise<void> {
    const challenge = await this.control("challenge");
    const nonce = Option.getOrThrow(fromBase64Url(challenge.nonce));

    const auth = {
      t: "auth" as const,
      role,
      key: toBase64Url(this.identity.publicKey),
      sig: toBase64Url(proveRelayKey(this.identity, nonce, role)),
    };

    this.sendText(encodeControl(peers === undefined ? auth : { ...auth, peers }));
    this.address = (await this.control("ready")).address;
  }

  setPeers(peers: ReadonlyArray<RelayAddress>): void {
    this.sendText(encodeControl({ t: "peers", peers }));
  }

  sendRecord(peer: RelayAddress, record: Uint8Array): void {
    this.sendBytes(encodeDataFrame(RelayOp.Forward, peer, record));
  }

  sendText(text: string): void {
    this.sent.push(text);
    this.ws.send(text);
  }

  sendBytes(bytes: Uint8Array): void {
    this.sent.push(bytes);
    this.ws.send(bytes);
  }

  /** The next control message of type `t`, skipping others; fails after a few seconds. */
  async control<T extends RelayControl["t"]>(t: T): Promise<Extract<RelayControl, { t: T }>> {
    const found = await this.next(
      (m): m is { kind: "control"; message: Extract<RelayControl, { t: T }> } =>
        m.kind === "control" && m.message.t === t
    );

    return found.message;
  }

  async data(): Promise<DataFrame> {
    return (await this.next((m): m is Extract<Inbound, { kind: "data" }> => m.kind === "data"))
      .frame;
  }

  /** Every control message received so far. */
  controls(): Array<RelayControl> {
    return this.inbox.flatMap((m) => (m.kind === "control" ? [m.message] : []));
  }

  close(): Promise<Closed> {
    this.ws.close();

    return this.closed;
  }

  private async next<I extends Inbound>(match: (m: Inbound) => m is I): Promise<I> {
    const deadline = Date.now() + WAIT_MS;

    for (;;) {
      const found = this.inbox.find(match);

      if (found !== undefined) {
        this.inbox.splice(this.inbox.indexOf(found), 1);

        return found;
      }

      if (Date.now() > deadline) throw new Error("timed out waiting for the relay");
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, 50);
      });
    }
  }

  /** binaryType is "arraybuffer", so a message is text or an ArrayBuffer. */
  private static parse(data: string | ArrayBuffer): Inbound {
    return Predicate.isString(data)
      ? { kind: "control", message: Option.getOrThrow(decodeRelayControl(data)) }
      : { kind: "data", frame: Option.getOrThrow(decodeDataFrame(new Uint8Array(data))) };
  }
}
