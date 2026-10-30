/**
 * Browser hosting and Browser streams (ENG-613, ENG-616, ADR 0092): the first requests that
 * go from the Daemon to a Client. A Desktop App that announced `browser.host` in `hello`
 * opens `browser.host` and keeps it open; while it is, the connection can host Browsers,
 * and the Daemon sends it requests as that stream's items. Capability `browser.host`.
 *
 * Hosting: the Desktop App claims an Agent Session's Browser when it shows it and releases
 * it when it closes it. The Daemon routes the session to the connection that claimed it
 * last, else to one where the user is present, which then opens the Browser in the background.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  ByteCount,
  ByteStreamCloseReason,
  ByteStreamId,
  ByteStreamRpcs,
  ByteStreamWindow,
} from "./byteStreams.ts";
import { HostAddressRpcs } from "./hostAddress.ts";
import { NotFound, Unsupported } from "./errors.ts";
import { BlobId, SessionId } from "./ids.ts";

/** The exact copy a browser tool call fails with when no Desktop App can host the Browser. */
export const NO_DESKTOP_APP_MESSAGE = "No Desktop App is connected to show this Browser.";

/** No connection can host this Agent Session's Browser. */
export class NoDesktopApp extends Schema.TaggedError<NoDesktopApp>()("NoDesktopApp", {
  sessionId: SessionId,
}) {
  override get message(): string {
    return NO_DESKTOP_APP_MESSAGE;
  }
}

/**
 * What a Browser stream carries. `cdp`: Chrome DevTools Protocol messages for the session's
 * Browser, each one JSON followed by `CDP_MESSAGE_DELIMITER`, in both directions.
 */
export const BrowserStreamPurpose = Schema.Literals(["cdp"]);

export type BrowserStreamPurpose = typeof BrowserStreamPurpose.Type;

/**
 * Ends each CDP message on a `cdp` stream. Safe only because each end re-serializes a message
 * compactly before delimiting it (`cdpFraming.ts`): a peer's pretty-printed JSON has raw newlines.
 */
export const CDP_MESSAGE_DELIMITER = 0x0a;

export const BrowserHostItem = Schema.TaggedUnion({
  /**
   * Open a Browser stream for `sessionId`, opening its Browser in the background if it is not
   * on screen. `downstream` carries the Daemon's bytes; `window` is what the Daemon buffers of
   * the Client's. Answer with `browser.acceptStream`, or `browser.closeStream` with `refused`.
   */
  Open: {
    streamId: ByteStreamId,
    sessionId: SessionId,
    purpose: BrowserStreamPurpose,
    downstream: BlobId,
    window: ByteStreamWindow,
  },
  /** The Daemon consumed `bytes` of the stream's `upstream`: the Client may send that many more. */
  Credit: { streamId: ByteStreamId, bytes: ByteCount },
  /** The Daemon closed the stream; drop both of its blobs. */
  Close: { streamId: ByteStreamId, reason: ByteStreamCloseReason },
});

export type BrowserHostItem = typeof BrowserHostItem.Type;

/**
 * Registers this connection as able to host Browsers for as long as the stream is open; its
 * items are the Daemon's requests. Fails `Unsupported` when the Client did not announce
 * `browser.host` in `hello`. Ending it releases every claim the connection holds.
 */
export const BrowserHost = Rpc.make("browser.host", {
  payload: {},
  success: BrowserHostItem,
  error: Unsupported,
  stream: true,
});

/**
 * This connection shows `sessionId`'s Browser, so the session's Browser streams come here.
 * Needs an open `browser.host` on the same connection, else `Unsupported`.
 */
export const BrowserClaim = Rpc.make("browser.claim", {
  payload: { sessionId: SessionId },
  error: Schema.Union([NotFound, Unsupported]),
});

/** This connection no longer shows `sessionId`'s Browser. Releasing what it never claimed is a no-op. */
export const BrowserRelease = Rpc.make("browser.release", {
  payload: { sessionId: SessionId },
});

/**
 * Accepts an `Open`: `upstream` is the blob of the Client's bytes, and `window` what the
 * Client buffers of `downstream` before it grants `byteStream.credit`.
 */
export const BrowserAcceptStream = Rpc.make("browser.acceptStream", {
  payload: { streamId: ByteStreamId, upstream: BlobId, window: ByteStreamWindow },
  error: Schema.Union([NotFound, Unsupported]),
});

/** The Client refuses an `Open`, or closes an accepted stream, in both directions. */
export const BrowserCloseStream = Rpc.make("browser.closeStream", {
  payload: { streamId: ByteStreamId, reason: ByteStreamCloseReason },
  error: Schema.Union([NotFound, Unsupported]),
});

export class BrowserRpcs extends RpcGroup.make(
  BrowserHost,
  BrowserClaim,
  BrowserRelease,
  BrowserAcceptStream,
  BrowserCloseStream
) {}

/** Every RPC the Browser rests on: byte streams, Host-address streams and Browser hosting. */
export class BrowserStackRpcs extends ByteStreamRpcs.merge(HostAddressRpcs, BrowserRpcs) {}
