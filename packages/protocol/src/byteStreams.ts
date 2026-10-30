/**
 * Byte streams over a Client's connection to the Daemon (ENG-613, ADR 0093): Host-address
 * streams (`hostAddress.ts`) and Browser streams (`browser.ts`). Each direction is one
 * long-lived blob, as `terminal.attachBinary` and `attachments.stage` already use, so the
 * Wire's round-robin keeps RPC frames ahead of the bytes; a blob's final chunk is that
 * direction's end (a half-close). A stream ends with its connection: its blobs fail `closed`.
 *
 * Flow control is credit-based, because the Wire buffers an incoming blob without pausing
 * its sender. Each side names a `window` when the stream opens: the bytes it will buffer
 * unread. A sender keeps `sent - credited <= window` and waits otherwise; a receiver grants
 * `Credit { bytes }` as it consumes them. The Client grants with `byteStream.credit`; the
 * Daemon grants with a `Credit` item on the RPC stream that opened the byte stream.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { NotFound, Unsupported } from "./errors.ts";

/** A byte stream, allocated by the Daemon and unique on its Host while it is open. */
export const ByteStreamId = Schema.String.pipe(Schema.brand("ByteStreamId"));

export type ByteStreamId = typeof ByteStreamId.Type;

/** The window a side offers when it has no reason to pick another: four blob chunks. */
export const BYTE_STREAM_WINDOW_BYTES = 1024 * 1024;

/** The largest window a side may ask its peer to honour: what one stream can hold unread. */
export const BYTE_STREAM_MAX_WINDOW_BYTES = 64 * 1024 * 1024;

/** Byte streams one connection may hold open at once, of both kinds together. */
export const MAX_BYTE_STREAMS_PER_CONNECTION = 128;

/** Bytes a side grants back once it has consumed them. */
export const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Bytes a side will buffer unread of the peer's blob, bounded so no stream can ask for more. */
export const ByteStreamWindow = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: BYTE_STREAM_MAX_WINDOW_BYTES })
);

/**
 * Why a byte stream ended in both directions. `closed`: one side finished normally.
 * `refused`: the peer would not open it. `failed`: a socket or blob failed underneath.
 * `revoked`: the Daemon withdrew it (its CDP token was revoked, or the Browser moved).
 */
export const ByteStreamCloseReason = Schema.Literals(["closed", "refused", "failed", "revoked"]);

export type ByteStreamCloseReason = typeof ByteStreamCloseReason.Type;

/**
 * The Client consumed `bytes` of the stream's Daemon-to-Client blob: the Daemon may send
 * that many more. Fails `NotFound` once the stream has closed, which the Client ignores.
 */
export const ByteStreamCredit = Rpc.make("byteStream.credit", {
  payload: { streamId: ByteStreamId, bytes: ByteCount },
  error: Schema.Union([NotFound, Unsupported]),
});

/** The byte-stream RPCs shared by both kinds (capability `host-address` or `browser.host`). */
export class ByteStreamRpcs extends RpcGroup.make(ByteStreamCredit) {}
