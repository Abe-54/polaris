/**
 * Preview frames onto a canvas within the Desktop App's budgets: each JPEG decodes off the main
 * thread (`createImageBitmap`) and at most one waits behind the one decoding; a newer frame
 * replaces it, so a slow decode drops frames rather than queueing them.
 */

export interface FramePainterOptions<Image> {
  readonly decode: (bytes: Uint8Array) => Promise<Image>;
  readonly paint: (image: Image) => void;
  /** Frees an image decoded after the painter closed. */
  readonly discard?: (image: Image) => void;
}

export interface FramePainter {
  readonly push: (bytes: Uint8Array) => void;
  readonly close: () => void;
}

export const framePainter = <Image>({
  decode,
  paint,
  discard,
}: FramePainterOptions<Image>): FramePainter => {
  let busy = false;
  let closed = false;
  let waiting: Uint8Array | null = null;

  const run = async (bytes: Uint8Array): Promise<void> => {
    busy = true;

    try {
      const image = await decode(bytes);

      if (closed) discard?.(image);
      else paint(image);
    } catch {
      // A frame that won't decode is skipped; the next one replaces it.
    } finally {
      busy = false;
      const next = waiting;

      waiting = null;

      if (next !== null && !closed) void run(next);
    }
  };

  return {
    push: (bytes) => {
      if (closed) return;

      if (busy) waiting = bytes;
      else void run(bytes);
    },
    close: () => {
      closed = true;
      waiting = null;
    },
  };
};

/** A JPEG to an ImageBitmap, decoded off the main thread. */
export const decodeJpeg = (bytes: Uint8Array): Promise<ImageBitmap> =>
  // SAFETY: the bytes come from structured clone, so they own a plain ArrayBuffer.
  createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));

/**
 * Paints a bitmap with the `bitmaprenderer` context, which takes the bitmap without a copy; the
 * canvas takes the image's own size and CSS scales it.
 */
export const canvasPainter = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext("bitmaprenderer");

  return (bitmap: ImageBitmap) => {
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;

    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;

    if (context === null) bitmap.close();
    else context.transferFromImageBitmap(bitmap);
  };
};
