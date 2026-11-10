/**
 * Where preview images come from on this Host (ENG-846): a live capture of the session's
 * window on macOS (`capture.ts`), the screenshot its last action took elsewhere (`still.ts`).
 */
import type {
  AppRef,
  AppWindow,
  PreviewIdleReason,
  PreviewLink,
  SessionId,
} from "@polaris/protocol";
import { Context, Data, type Effect, type Option, type Stream } from "effect";

/** One JPEG of a session's window, before it is offered to a Client as a blob. */
export interface PreviewImage {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Milliseconds since the epoch. */
  readonly capturedAt: number;
  readonly app: AppRef;
  /** Null for a capture of the whole screen. */
  readonly window: AppWindow | null;
}

export type PreviewEvent = Data.TaggedEnum<{
  Frame: { readonly image: PreviewImage };
  Idle: { readonly reason: PreviewIdleReason };
}>;

export const PreviewEvent = Data.taggedEnum<PreviewEvent>();

export interface WatchRequest {
  readonly sessionId: SessionId;
  /** The image's longer side, already clamped (`previewEdge`). */
  readonly edge: number;
  readonly link: PreviewLink;
}

export class PreviewSource extends Context.Service<
  PreviewSource,
  {
    /** Whether this Host captures a window live (capability `computer-use.preview`). */
    readonly live: boolean;
    /**
     * The session's window as it changes. Capture runs only while this stream has a consumer;
     * a slow consumer gets the newest event and never a backlog. Dies when `live` is false.
     */
    readonly watch: (request: WatchRequest) => Stream.Stream<PreviewEvent>;
    /** One image of what the session last acted on, or none. */
    readonly latest: (
      request: Omit<WatchRequest, "link">
    ) => Effect.Effect<Option.Option<PreviewImage>>;
  }
>()("polaris/daemon/computerUse/PreviewSource") {}
