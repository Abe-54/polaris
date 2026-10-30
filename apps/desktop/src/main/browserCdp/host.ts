/**
 * The Desktop App's side of `browser.host` (ENG-616, ADR 0092): each `Open` the Daemon sends
 * becomes a `cdp` Browser stream served by a facade over that session's tabs. Streams are
 * known only to the connection that opened them; credits keep the blobs within each window.
 */
import {
  BYTE_STREAM_WINDOW_BYTES,
  type BrowserHostItem,
  type ByteStreamCloseReason,
  type ByteStreamId,
  CdpMessageDecoder,
  encodeCdpMessage,
} from "@polaris/protocol";
import type { LiveSession } from "@polaris/client";
import { type Cause, Effect, Latch, Match, Queue, Stream } from "effect";
import { type CdpVersions, cdpFacade } from "./facade.ts";
import type { CdpTabs } from "./ports.ts";

export interface BrowserHostDeps {
  readonly hostKey: string;
  readonly tabs: CdpTabs;
  readonly versions: CdpVersions;
}

/** Credits are granted once this much of the Daemon's bytes is consumed, not per chunk. */
const CREDIT_BATCH_BYTES = BYTE_STREAM_WINDOW_BYTES / 4;

/** Messages for the Daemon held while its window is closed, before the stream is failed. */
export const OUTBOUND_MAX_MESSAGES = 1024;

interface StreamEnd {
  /** The Daemon consumed this many of our bytes. */
  readonly credit: (bytes: number) => void;
  /** Ends the stream; `reason` null when the Daemon closed it first. */
  readonly end: (reason: ByteStreamCloseReason | null) => Effect.Effect<void>;
}

type Open = Extract<BrowserHostItem, { _tag: "Open" }>;

/** Our bytes toward the Daemon, held to its window: `sent - credited <= window`. */
const creditedPump = (
  source: Queue.Dequeue<Uint8Array, Cause.Done>,
  sink: Queue.Queue<Uint8Array, Cause.Done>,
  window: number
) => {
  let sent = 0;
  let credited = 0;
  const credits = Latch.makeUnsafe(false);
  const room = () => window - (sent - credited);

  const push = (bytes: Uint8Array) =>
    Effect.gen(function* () {
      let offset = 0;

      while (offset < bytes.length) {
        while (room() <= 0) {
          credits.closeUnsafe();

          if (room() > 0) break;
          yield* credits.await;
        }

        const slice = bytes.subarray(offset, offset + room());
        Queue.offerUnsafe(sink, slice);
        sent += slice.length;
        offset += slice.length;
      }
    });

  return {
    run: Stream.fromQueue(source).pipe(
      Stream.runForEach(push),
      Effect.ensuring(Effect.sync(() => Queue.endUnsafe(sink)))
    ),
    credit: (bytes: number) => {
      credited += bytes;
      credits.openUnsafe();
    },
  };
};

/** Serves Browser streams for `session` until its `browser.host` stream ends. */
export const serveBrowserHost = (
  session: LiveSession,
  deps: BrowserHostDeps
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const streams = new Map<ByteStreamId, StreamEnd>();

    const openStream = Effect.fn("browserHost.open")(function* (open: Open) {
      if (open.purpose !== "cdp" || streams.has(open.streamId)) return;

      const outbound = yield* Queue.make<Uint8Array, Cause.Done>({
        capacity: OUTBOUND_MAX_MESSAGES,
        strategy: "dropping",
      });

      const upstream = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const pump = creditedPump(outbound, upstream, open.window);
      const decoder = new CdpMessageDecoder();
      let ended = false;

      const fail = () => Effect.runFork(end("failed"));

      const facade = cdpFacade({
        hostKey: deps.hostKey,
        sessionId: open.sessionId,
        tabs: deps.tabs,
        versions: deps.versions,
        // A Daemon that stops taking our bytes, or an agent past a bound, ends the stream.
        send: (message) => {
          if (!Queue.offerUnsafe(outbound, encodeCdpMessage(message))) fail();
        },
        overflow: fail,
      });

      const end = (reason: ByteStreamCloseReason | null) =>
        Effect.gen(function* () {
          if (ended) return;
          ended = true;
          streams.delete(open.streamId);
          facade.close();
          Queue.endUnsafe(outbound);

          if (reason !== null)
            yield* session.client["browser.closeStream"]({ streamId: open.streamId, reason }).pipe(
              Effect.ignore
            );
        });

      streams.set(open.streamId, { credit: pump.credit, end });
      const blobId = yield* session.blobs.offer(Stream.fromQueue(upstream));

      const accepted = yield* session.client["browser.acceptStream"]({
        streamId: open.streamId,
        upstream: blobId,
        window: BYTE_STREAM_WINDOW_BYTES,
      }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      );

      if (!accepted) return yield* end(null);
      let consumed = 0;

      const grant = Effect.suspend(() => {
        const bytes = consumed;
        consumed = 0;

        return session.client["byteStream.credit"]({ streamId: open.streamId, bytes }).pipe(
          Effect.ignore
        );
      });

      const reader = session.blobs.takeStream(open.downstream, { idleTimeout: false }).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            for (const message of yield* Effect.try(() => decoder.feed(chunk)))
              facade.receive(message);
            consumed += chunk.byteLength;

            if (consumed >= CREDIT_BATCH_BYTES) yield* grant;
          })
        ),
        Effect.matchEffect({ onSuccess: () => end("closed"), onFailure: () => end("failed") })
      );

      yield* Effect.forkScoped(pump.run);
      yield* Effect.forkScoped(reader);
    });

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...streams.values()], (stream) => stream.end(null), { discard: true })
    );

    yield* session.client["browser.host"]({}).pipe(
      Stream.runForEach((item) =>
        Match.valueTags(item, {
          Open: openStream,
          Credit: ({ streamId, bytes }) => Effect.sync(() => streams.get(streamId)?.credit(bytes)),
          Close: ({ streamId }) => streams.get(streamId)?.end(null) ?? Effect.void,
        })
      ),
      Effect.ignore
    );
  }).pipe(Effect.scoped);
