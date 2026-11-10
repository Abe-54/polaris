/**
 * The preview on a Host with no live capture (Linux, Windows): the screenshot the session's
 * last computer use action took, scaled and re-encoded as the protocol's JPEG.
 */
import { PREVIEW_MAX_FRAME_BYTES } from "@polaris/protocol";
import { Effect, Layer, Option, Stream } from "effect";
import { type PreviewImage, PreviewSource } from "./source.ts";
import { type PreviewScreenshot, PreviewTargets } from "./targets.ts";

/** Tried in order until the image fits in `PREVIEW_MAX_FRAME_BYTES`. */
const QUALITIES = [70, 50, 30, 15] as const;

/** `width` by `height` scaled down so its longer side is at most `edge`; never enlarged. */
export const fit = (width: number, height: number, edge: number) => {
  const ratio = Math.min(1, edge / Math.max(width, height, 1));

  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
};

const encode = async (screenshot: PreviewScreenshot, edge: number, limit: number) => {
  const { width, height } = await new Bun.Image(screenshot.image).metadata();
  const size = fit(width, height, edge);

  for (const quality of QUALITIES) {
    const jpeg = await new Bun.Image(screenshot.image)
      .resize(size.width, size.height)
      .jpeg({ quality })
      .bytes();

    if (jpeg.length <= limit) return Option.some({ jpeg, ...size });
  }

  return Option.none();
};

/** The screenshot as a preview image; none when it is no image or no quality fits `limit`. */
export const stillImage = (
  screenshot: PreviewScreenshot,
  edge: number,
  limit: number = PREVIEW_MAX_FRAME_BYTES
): Effect.Effect<Option.Option<PreviewImage>> =>
  Effect.tryPromise(() => encode(screenshot, edge, limit)).pipe(
    Effect.map(
      Option.map((encoded) => ({
        ...encoded,
        capturedAt: screenshot.takenAt,
        app: screenshot.app,
        window: screenshot.window,
      }))
    ),
    Effect.catch(() => Effect.succeedNone)
  );

export const stillLayer = Layer.effect(
  PreviewSource,
  Effect.gen(function* () {
    const targets = yield* PreviewTargets;

    return PreviewSource.of({
      live: false,
      watch: () => Stream.die("this Host has no live preview"),
      // None before the first action, and where the Host can't take one (Wayland outside GNOME).
      latest: ({ sessionId, edge }) =>
        Effect.flatMap(
          targets.screenshot(sessionId),
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (screenshot) => stillImage(screenshot, edge),
          })
        ),
    });
  })
);
