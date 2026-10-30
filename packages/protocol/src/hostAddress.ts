/**
 * Host-address streams (ENG-613, ADR 0093): a Client opens one per SOCKS connection its
 * Browser makes to a Host address, and the Daemon connects to its own loopback. Framing and
 * flow control are in `byteStreams.ts`. Capability `host-address`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ByteCount, ByteStreamId, ByteStreamWindow } from "./byteStreams.ts";
import { Unsupported } from "./errors.ts";
import { BlobId } from "./ids.ts";

/** A TCP port on the Host's loopback. */
export const HostAddressPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

/**
 * Why a Host-address stream could not open or stopped. `not-host-address`: the hostname is
 * not `localhost`, a `*.localhost` name or a loopback IP. `refused`, `unreachable`, `timeout`:
 * the loopback connect failed. `reset`: the open socket failed. `too-many-streams`: the
 * connection holds `MAX_BYTE_STREAMS_PER_CONNECTION` already.
 */
export const HostAddressFailure = Schema.Literals([
  "not-host-address",
  "refused",
  "unreachable",
  "timeout",
  "reset",
  "too-many-streams",
]);

/** The loopback address a Daemon connects to for a Host address: never a resolved name. */
export type LoopbackAddress = "127.0.0.1" | "::1";

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const isIpv4Loopback = (name: string): boolean => {
  const match = IPV4_LOOPBACK.exec(name);

  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
};

/** IPv4 loopback mapped into IPv6, dotted (`::ffff:127.0.0.1`) or as Chromium spells it (`::ffff:7f00:1`). */
const isMappedIpv4Loopback = (lower: string): boolean => {
  const mapped = /^::ffff:(.+)$/.exec(lower);

  if (mapped === null) return false;
  const rest = mapped[1]!;

  if (isIpv4Loopback(rest)) return true;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);

  return hex !== null && (parseInt(hex[1]!, 16) & 0xff00) === 0x7f00;
};

/** `::1`, with or without brackets, in any of its spellings; or IPv4 loopback mapped into IPv6. */
const isIpv6Loopback = (name: string): boolean => {
  const bare = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
  const lower = bare.toLowerCase();

  return lower === "::1" || lower === "0:0:0:0:0:0:0:1" || isMappedIpv4Loopback(lower);
};

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether `hostname` is a Host address, and the loopback addresses it stands for, in the order
 * to try them: `localhost` and every `*.localhost` name (RFC 6761: never looked up) mean both
 * families, IPv4 first, since a server may listen on only one (Vite on Node 24 takes `[::1]`);
 * a loopback IP literal means itself alone. Any other name or address, including one that
 * would resolve to loopback, is not a Host address (ADR 0093).
 */
export const loopbackAddressesOf = (hostname: string): ReadonlyArray<LoopbackAddress> | null => {
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  const lower = name.toLowerCase();

  if (lower === "localhost") return LOOPBACK_NAME_ADDRESSES;

  if (lower.endsWith(".localhost")) {
    const labels = lower.slice(0, -".localhost".length).split(".");

    return labels.every((label) => DNS_LABEL.test(label)) ? LOOPBACK_NAME_ADDRESSES : null;
  }

  if (isIpv4Loopback(name)) return ["127.0.0.1"];

  if (isIpv6Loopback(name)) return ["::1"];

  return null;
};

/** What a loopback name stands for: both families, IPv4 first. */
const LOOPBACK_NAME_ADDRESSES: ReadonlyArray<LoopbackAddress> = ["127.0.0.1", "::1"];

/** True when `hostname` is a Host address (`loopbackAddressesOf`). */
export const isHostAddress = (hostname: string): boolean => loopbackAddressesOf(hostname) !== null;

export class HostAddressError extends Schema.TaggedError<HostAddressError>()("HostAddressError", {
  hostname: Schema.String,
  port: HostAddressPort,
  reason: HostAddressFailure,
  message: Schema.String,
}) {}

/** The stream is open: `downstream` carries the Host's bytes; `window` is the Daemon's. */
export const HostAddressOpened = Schema.Struct({
  streamId: ByteStreamId,
  downstream: BlobId,
  window: ByteStreamWindow,
});

export const HostAddressStreamItem = Schema.TaggedUnion({
  /** Always the first item. */
  Opened: HostAddressOpened.fields,
  /** The Daemon wrote `bytes` of `upstream` to the socket: the Client may send that many more. */
  Credit: { bytes: ByteCount },
});

export type HostAddressStreamItem = typeof HostAddressStreamItem.Type;

/**
 * Opens a byte stream to `hostname:port` on the Host's loopback. `hostname` travels
 * unresolved (`app.localhost`), so Portless can route by SNI and Host header; the Daemon
 * refuses any other name with `not-host-address`. The Client first offers `upstream`, the
 * blob of its bytes, and sends at most `window` of the Daemon's before a `Credit`; `window`
 * is what the Client will buffer of `downstream` before it grants `byteStream.credit`. The
 * RPC stream ends once both blobs have; ending it closes the socket.
 */
export const HostAddressOpen = Rpc.make("hostAddress.open", {
  payload: {
    hostname: Schema.String.check(Schema.isMinLength(1)),
    port: HostAddressPort,
    upstream: BlobId,
    window: ByteStreamWindow,
  },
  success: HostAddressStreamItem,
  error: Schema.Union([HostAddressError, Unsupported]),
  stream: true,
});

export class HostAddressRpcs extends RpcGroup.make(HostAddressOpen) {}
