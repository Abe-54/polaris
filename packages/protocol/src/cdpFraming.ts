/**
 * Framing for `cdp` Browser streams (ENG-616, ADR 0092): one compact JSON text per message,
 * each ended by `CDP_MESSAGE_DELIMITER`. Both ends parse and re-serialize what they take in
 * before delimiting it, so a peer that pretty-prints its JSON never splits a message.
 */
import { Option, Schema } from "effect";
import { CDP_MESSAGE_DELIMITER } from "./browser.ts";

/** The most a single CDP message may take on a stream: Chrome's own ceiling for a message. */
export const CDP_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

/** Any JSON a CDP message carries: parameters, results, event payloads. */
export type CdpJson = typeof Schema.Json.Type;

export const CdpError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Json),
});

export type CdpError = typeof CdpError.Type;

/**
 * One Chrome DevTools Protocol message, whichever way it travels: a command (`id`, `method`),
 * its reply (`id` with `result` or `error`), or an event (`method` without `id`). `sessionId`
 * names the page session; a message without one is browser-level.
 */
export const CdpMessage = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Int, Schema.String, Schema.Null])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Json),
  sessionId: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(CdpError),
});

export type CdpMessage = typeof CdpMessage.Type;

const decodeCdpMessage = Schema.decodeUnknownOption(CdpMessage);

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/** `message` as compact JSON followed by the delimiter. */
export const encodeCdpMessage = (message: CdpMessage): Uint8Array =>
  encoder.encode(`${JSON.stringify(message)}\n`);

/** `text` as its sender wrote it; `null` when it is not JSON shaped as a CDP message. */
export const parseCdpMessage = (text: string): CdpMessage | null => {
  try {
    return Option.getOrNull(decodeCdpMessage(JSON.parse(text)));
  } catch {
    return null;
  }
};

export class CdpFramingError extends Error {
  override readonly name = "CdpFramingError";
}

/**
 * Splits a `cdp` stream's bytes into messages at the delimiter, across chunk boundaries.
 * `feed` fails with `CdpFramingError` on a message over `CDP_MAX_MESSAGE_BYTES` or one that
 * is not a CDP message; the stream is then unusable and its owner closes it as `failed`.
 */
export class CdpMessageDecoder {
  private pending: Array<Uint8Array> = [];
  private pendingBytes = 0;

  feed(chunk: Uint8Array): ReadonlyArray<CdpMessage> {
    const messages: Array<CdpMessage> = [];
    let start = 0;

    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== CDP_MESSAGE_DELIMITER) continue;
      messages.push(this.complete(chunk.subarray(start, i)));
      start = i + 1;
    }

    if (start < chunk.length) this.hold(chunk.subarray(start));

    return messages;
  }

  private hold(part: Uint8Array): void {
    this.pendingBytes += part.byteLength;

    if (this.pendingBytes > CDP_MAX_MESSAGE_BYTES)
      throw new CdpFramingError(`a CDP message exceeds ${CDP_MAX_MESSAGE_BYTES} bytes`);
    this.pending.push(part);
  }

  private complete(last: Uint8Array): CdpMessage {
    this.hold(last);
    const bytes = new Uint8Array(this.pendingBytes);
    let offset = 0;

    for (const part of this.pending) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }

    this.pending = [];
    this.pendingBytes = 0;
    const message = parseCdpMessage(decoder.decode(bytes));

    if (message === null) throw new CdpFramingError("a CDP message is not JSON");

    return message;
  }
}
