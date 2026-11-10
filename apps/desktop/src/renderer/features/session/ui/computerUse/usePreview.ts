/**
 * A session's window, from its Host (`computerUse.preview.*`): live frames while a view is open
 * (subscribing starts the Host's capture, closing the view ends it), else its last frame.
 */
import {
  type AppWindow,
  PREVIEW_MIN_EDGE_PX,
  type PreviewIdleReason,
  type SessionId,
} from "@polaris/protocol";
import { Predicate } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewFeedItem } from "../../../../../shared/computerUseContract.ts";
import { polaris } from "../../../bridge.ts";
import { canvasPainter, decodeJpeg, type FramePainter, framePainter } from "./frames.ts";

export type PreviewStatus =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "frames";
      readonly window: AppWindow | null;
      /** A still frame's time; null for live frames (`SessionPreview.capturedAt`). */
      readonly capturedAt: string | null;
    }
  | { readonly kind: "idle"; readonly reason: PreviewIdleReason }
  /** No image: the session hasn't acted yet, or the Host can't take screenshots. */
  | { readonly kind: "empty" };

export interface SessionPreview {
  /** The canvas frames paint onto. */
  readonly canvas: (element: HTMLCanvasElement | null) => void;
  readonly status: PreviewStatus;
  /** False once the Host says it has no live capture; null until it says either. */
  readonly live: boolean | null;
  /** A frame has been painted: a locked screen keeps showing it. */
  readonly painted: boolean;
  /** The newest frame's capture time, read at render (a ref: frames never re-render alone). */
  readonly capturedAt: string | null;
}

export interface PreviewTarget {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  /** The view's longer side in device pixels. */
  readonly maxEdgePx: number;
  /** Changes when the session acts again, so a still frame is fetched anew. */
  readonly refresh: string;
}

const WAITING: PreviewStatus = { kind: "waiting" };

/** Paints onto whichever canvas is mounted; the newest frame waits for one that isn't yet. */
const usePainter = () => {
  const painter = useRef<FramePainter | null>(null);
  const early = useRef<Uint8Array | null>(null);

  const canvas = useCallback((element: HTMLCanvasElement | null) => {
    painter.current?.close();
    painter.current =
      element === null
        ? null
        : framePainter({
            decode: decodeJpeg,
            paint: canvasPainter(element),
            discard: (bitmap) => bitmap.close(),
          });

    if (painter.current !== null && early.current !== null) {
      painter.current.push(early.current);
      early.current = null;
    }
  }, []);

  const push = useCallback((bytes: Uint8Array) => {
    if (painter.current === null) early.current = bytes;
    else painter.current.push(bytes);
  }, []);

  useEffect(() => () => painter.current?.close(), []);

  return { canvas, push };
};

const sameStatus = (a: PreviewStatus, b: PreviewStatus) =>
  a.kind === b.kind &&
  (a.kind !== "frames" ||
    (b.kind === "frames" && a.window?.id === b.window?.id && a.capturedAt === b.capturedAt)) &&
  (a.kind !== "idle" || (b.kind === "idle" && a.reason === b.reason));

/** Only the batch's newest frame is decoded; the rest are dropped. */
const isFrame = (item: PreviewFeedItem) => Predicate.isTagged(item, "Frame");

const newestFrame = (items: ReadonlyArray<PreviewFeedItem>) =>
  items.findLast(isFrame)?.image ?? null;

const idleOf = (item: PreviewFeedItem | undefined) =>
  item !== undefined && Predicate.isTagged(item, "Idle") ? item.reason : null;

/**
 * While `open`: subscribes to the session's live frames, or on a Host without live capture
 * fetches its last frame (again on each `refresh`). Closing unsubscribes.
 */
export const useSessionPreview = (target: PreviewTarget, open: boolean): SessionPreview => {
  const { canvas, push: paint } = usePainter();
  const [painted, setPainted] = useState(false);
  const capturedAt = useRef<string | null>(null);
  const [status, setStatusState] = useState<PreviewStatus>(WAITING);

  const push = useCallback(
    (bytes: Uint8Array) => {
      paint(bytes);
      setPainted(true);
    },
    [paint]
  );

  const [live, setLive] = useState<boolean | null>(null);
  const { hostKey, sessionId, maxEdgePx, refresh } = target;

  const setStatus = useCallback(
    (next: PreviewStatus) => setStatusState((was) => (sameStatus(was, next) ? was : next)),
    []
  );

  useEffect(() => {
    if (!open || live === false) return undefined;
    setStatus(WAITING);

    return polaris().subscribe(
      "computerUse.preview.watch",
      { hostKey, sessionId, maxEdgePx },
      {
        items: (items) => {
          if (items.some((item) => Predicate.isTagged(item, "NoLive"))) {
            setLive(false);

            return;
          }

          setLive(true);
          const image = newestFrame(items);
          const idle = idleOf(items.at(-1));

          // A frame before an idle reason still paints: a locked screen shows its last frame.
          if (image !== null) {
            push(image.bytes);
            capturedAt.current = image.capturedAt;
          }

          if (idle !== null) setStatus({ kind: "idle", reason: idle });
          else if (image !== null)
            setStatus({ kind: "frames", window: image.window, capturedAt: null });
        },
        // An older Daemon refuses the feed; its last frame is still worth showing.
        end: (error) => {
          if (error !== null) setLive(false);
        },
      }
    );
  }, [open, live, hostKey, sessionId, maxEdgePx, push, setStatus]);

  useEffect(() => {
    if (!open || live !== false) return undefined;
    let current = true;

    void polaris()
      .request("computerUse.preview.latest", { hostKey, sessionId, maxEdgePx })
      .then((result) => {
        if (!current) return;

        if (!result.ok || result.value === null) {
          setStatus({ kind: "empty" });

          return;
        }

        push(result.value.bytes);
        capturedAt.current = result.value.capturedAt;
        setStatus({
          kind: "frames",
          window: result.value.window,
          capturedAt: result.value.capturedAt,
        });
      });

    return () => {
      current = false;
    };
  }, [open, live, hostKey, sessionId, maxEdgePx, refresh, push, setStatus]);

  return { canvas, status, live, painted, capturedAt: capturedAt.current };
};

/** The thumbnail's image: the session's latest frame, small, as an object URL; null without one. */
export const useLatestThumbnail = (
  target: Omit<PreviewTarget, "maxEdgePx">,
  enabled: boolean
): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  const { hostKey, sessionId, refresh } = target;

  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    let made: string | null = null;

    void polaris()
      .request("computerUse.preview.latest", { hostKey, sessionId, maxEdgePx: THUMBNAIL_EDGE })
      .then((result) => {
        if (!current || !result.ok || result.value === null) return;
        // SAFETY: the bytes come from structured clone, so they own a plain ArrayBuffer.
        const bytes = result.value.bytes as Uint8Array<ArrayBuffer>;

        made = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        setUrl(made);
      });

    return () => {
      current = false;

      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [enabled, hostKey, sessionId, refresh]);

  return enabled ? url : null;
};

/** The smallest edge the Daemon serves (`PREVIEW_MIN_EDGE_PX`): enough for a 60×38 thumbnail. */
const THUMBNAIL_EDGE = PREVIEW_MIN_EDGE_PX;
