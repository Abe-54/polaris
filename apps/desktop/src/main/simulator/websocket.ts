/**
 * A WebSocket client's half of RFC 6455 over a byte stream: the upgrade request and its check,
 * masked frames out, unmasked frames in. No extensions are offered, so none arrive.
 */
import { createHash, randomBytes } from "node:crypto";
import { concatBytes, type ResponseHead } from "./http.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** A message larger than this closes the socket: the hub's are small. */
export const MAX_MESSAGE = 16 * 1024 * 1024;

export const newKey = (): string => randomBytes(16).toString("base64");

export const acceptFor = (key: string): string =>
  createHash("sha1").update(`${key}${GUID}`).digest("base64");

/** The upgrade for `path`, the token as a Bearer header (both of the hub's gates take it). */
export const upgradeRequest = (port: number, path: string, token: string, key: string) =>
  Buffer.from(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Authorization: Bearer ${token}`,
      "",
      "",
    ].join("\r\n"),
    "latin1"
  );

/** Whether the server switched protocols for this key. */
export const upgraded = (head: ResponseHead, key: string) =>
  head.status === 101 &&
  head.headers.get("upgrade")?.toLowerCase() === "websocket" &&
  head.headers.get("sec-websocket-accept") === acceptFor(key);

/** One frame from the client, always masked (RFC 6455 5.3). */
export const encodeFrame = (
  opcode: number,
  payload: Uint8Array,
  mask: Uint8Array = randomBytes(4)
): Uint8Array => {
  const length = payload.length;
  const extended = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const frame = new Uint8Array(2 + extended + 4 + length);
  const view = new DataView(frame.buffer);

  frame[0] = 0x80 | opcode;

  if (extended === 0) frame[1] = 0x80 | length;
  else if (extended === 2) {
    frame[1] = 0x80 | 126;
    view.setUint16(2, length);
  } else {
    frame[1] = 0x80 | 127;
    view.setBigUint64(2, BigInt(length));
  }

  const at = 2 + extended;

  frame.set(mask.subarray(0, 4), at);

  for (let i = 0; i < length; i++) frame[at + 4 + i] = payload[i]! ^ mask[i % 4]!;

  return frame;
};

export type Frame =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary"; readonly data: Uint8Array }
  | { readonly kind: "ping"; readonly data: Uint8Array }
  | { readonly kind: "pong" }
  | { readonly kind: "close"; readonly code: number; readonly reason: string }
  /** The stream broke the protocol: close at once. */
  | { readonly kind: "invalid"; readonly reason: string };

interface RawFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Uint8Array;
  readonly size: number;
}

type RawRead = RawFrame | "more" | "invalid";

const lengthOf = (bytes: Uint8Array, view: DataView): { length: number; at: number } | null => {
  const short = bytes[1]! & 0x7f;

  if (short < 126) return { length: short, at: 2 };

  if (short === 126) return bytes.length < 4 ? null : { length: view.getUint16(2), at: 4 };

  if (bytes.length < 10) return null;
  const long = view.getBigUint64(2);

  return { length: long > BigInt(MAX_MESSAGE) ? MAX_MESSAGE + 1 : Number(long), at: 10 };
};

const readRaw = (bytes: Uint8Array): RawRead => {
  if (bytes.length < 2) return "more";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = lengthOf(bytes, view);

  if (size === null) return "more";

  // A server never masks, and no extension sets the RSV bits.
  if ((bytes[1]! & 0x80) !== 0 || (bytes[0]! & 0x70) !== 0 || size.length > MAX_MESSAGE)
    return "invalid";

  if (bytes.length < size.at + size.length) return "more";

  return {
    fin: (bytes[0]! & 0x80) !== 0,
    opcode: bytes[0]! & 0x0f,
    payload: bytes.slice(size.at, size.at + size.length),
    size: size.at + size.length,
  };
};

const closeFrame = (payload: Uint8Array): Frame => ({
  kind: "close",
  code: payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 1005,
  reason: Buffer.from(payload.subarray(2)).toString("utf8"),
});

const dataFrame = (opcode: number, payload: Uint8Array): Frame =>
  opcode === OPCODE.text
    ? { kind: "text", text: Buffer.from(payload).toString("utf8") }
    : { kind: "binary", data: payload };

/** Reads frames from the server however its bytes are split, joining fragmented messages. */
export const frameDecoder = () => {
  let buffer: Uint8Array = new Uint8Array();
  let partial: { opcode: number; data: Uint8Array } | null = null;

  const control = (raw: RawFrame): Frame | null => {
    if (raw.opcode === OPCODE.ping) return { kind: "ping", data: raw.payload };

    if (raw.opcode === OPCODE.pong) return { kind: "pong" };

    return raw.opcode === OPCODE.close ? closeFrame(raw.payload) : null;
  };

  const message = (raw: RawFrame): Frame | null => {
    if (raw.opcode === OPCODE.continuation) {
      if (partial === null) return { kind: "invalid", reason: "continuation without a start" };
      partial.data = concatBytes(partial.data, raw.payload);

      if (partial.data.length > MAX_MESSAGE) return { kind: "invalid", reason: "too large" };
    } else if (partial !== null) return { kind: "invalid", reason: "interleaved message" };
    else partial = { opcode: raw.opcode, data: raw.payload };

    if (!raw.fin) return null;
    const done = partial;

    partial = null;

    return dataFrame(done.opcode, done.data);
  };

  const frame = (raw: RawFrame): Frame | null => {
    if (raw.opcode >= 0x8) return control(raw);

    if (raw.opcode > OPCODE.binary) return { kind: "invalid", reason: "unknown opcode" };

    return message(raw);
  };

  return (bytes: Uint8Array): ReadonlyArray<Frame> => {
    buffer = concatBytes(buffer, bytes);
    const out: Array<Frame> = [];

    for (;;) {
      const raw = readRaw(buffer);

      if (raw === "more") return out;

      if (raw === "invalid") return [...out, { kind: "invalid", reason: "bad frame" }];
      buffer = buffer.subarray(raw.size);
      const next = frame(raw);

      if (next !== null) out.push(next);

      if (next?.kind === "invalid") return out;
    }
  };
};

/** The close frame's payload: the code, then the reason. */
export const closePayload = (code: number): Uint8Array => Uint8Array.of(code >> 8, code & 0xff);
