/**
 * What the agent last saw, beside an approval: the session's `computerUse.preview.latest`, kept
 * as a file an image can show. Null before any frame, or on a Host that can't take one.
 */
import { type BlobId, type PreviewFrame, SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import type { LiveHost } from "../runtime/hostConnection.ts";

/** The longer side asked for: a phone thumbnail, not the full frame. */
export const FRAME_EDGE_PX = 640;

/** Keeps the frame's bytes under a name and answers a URI for them. */
export type KeepFrame = (name: string, bytes: Uint8Array) => Promise<string>;

export interface LastFrame {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

/** Where frames come from: the Host's `computerUse.preview.latest` and its blobs. */
export interface FrameSource {
  readonly latest: (sessionId: SessionId) => Effect.Effect<PreviewFrame | null, unknown>;
  readonly take: (blobId: BlobId) => Effect.Effect<Uint8Array, unknown>;
}

export const frameSource = (live: LiveHost): FrameSource => ({
  latest: (sessionId) =>
    live.client["computerUse.preview.latest"]({ sessionId, maxEdgePx: FRAME_EDGE_PX }),
  take: live.blobs.take,
});

export const lastFrame = (
  source: FrameSource | null,
  sessionId: string,
  keep: KeepFrame
): Promise<LastFrame | null> => {
  if (source === null) return Promise.resolve(null);

  const fetched = Effect.gen(function* () {
    const frame = yield* source.latest(SessionId.make(sessionId));

    if (frame === null) return null;
    const bytes = yield* source.take(frame.blobId);
    const name = `${sessionId}-${frame.capturedAt.replace(/[^0-9]/g, "")}.jpg`;
    const uri = yield* Effect.promise(() => keep(name, bytes));

    return { uri, width: frame.width, height: frame.height };
  });

  // Unsupported, NotFound or a dropped connection: the approval shows without a frame.
  return Effect.runPromise(Effect.orElseSucceed(fetched, () => null)).catch(() => null);
};
