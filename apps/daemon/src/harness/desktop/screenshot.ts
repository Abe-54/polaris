/**
 * A screenshot as the agent gets it: scaled down to screen points on macOS (so the image is
 * smaller and a pixel is a point), with a note on how its pixels map to the screen.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { ScreenshotData } from "./envelope.ts";

const Display = Schema.Struct({
  bounds: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
  scale: Schema.optionalKey(Schema.Number),
});

export type Display = typeof Display.Type;

/** `list-displays`' data, in index order (0 is the primary). */
export const decodeDisplays = Schema.decodeUnknownOption(Schema.Array(Display));

export interface Image {
  readonly data: string;
  readonly mimeType: string;
}

/** `sips` resamples to the point width and re-encodes as JPEG; the PNG stays when it can't. */
const sipsShrink = (png: string, width: number): Promise<Image> =>
  (async () => {
    const dir = await mkdtemp(join(tmpdir(), "polaris-shot-"));

    try {
      const input = join(dir, "in.png");
      const output = join(dir, "out.jpg");
      await writeFile(input, Buffer.from(png, "base64"));

      const proc = Bun.spawn(
        [
          "/usr/bin/sips",
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "80",
          "--resampleWidth",
          String(width),
          input,
          "--out",
          output,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
      );

      if ((await proc.exited) !== 0) throw new Error("sips failed");

      return { data: (await readFile(output)).toString("base64"), mimeType: "image/jpeg" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();

export interface Shrunk {
  readonly image: Image;
  /** Image pixels per screen point: 1 once shrunk, else the display's scale. */
  readonly pixelsPerPoint: number;
}

export const shrink = (shot: ScreenshotData): Effect.Effect<Shrunk> => {
  const scale = shot.scale_factor ?? 1;
  const original = { image: { data: shot.data, mimeType: "image/png" }, pixelsPerPoint: scale };

  if (process.platform !== "darwin" || scale <= 1) return Effect.succeed(original);

  return Effect.tryPromise(() => sipsShrink(shot.data, Math.round(shot.width / scale))).pipe(
    Effect.map((image): Shrunk => ({ image, pixelsPerPoint: 1 })),
    Effect.orElseSucceed(() => original)
  );
};

const scaled = (pixelsPerPoint: number, axis: string) =>
  pixelsPerPoint === 1 ? axis : `${axis} / ${pixelsPerPoint}`;

/** How a screen screenshot's pixels map to the points the headed tools take. */
export const screenNote = (
  displays: ReadonlyArray<Display>,
  screen: number,
  pixelsPerPoint: number
): string | null => {
  const display = displays[screen];

  if (display === undefined) return null;
  const { x, y } = display.bounds;

  return `Image pixel (px, py) is screen point (${x} + ${scaled(pixelsPerPoint, "px")}, ${y} + ${scaled(pixelsPerPoint, "py")}); pass that point to the headed tools.`;
};

export const WINDOW_NOTE =
  "A window screenshot includes its shadow, so its pixels don't map exactly to screen points; for headed input, screenshot the window's screen instead.";
