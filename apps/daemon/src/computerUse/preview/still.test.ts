import { expect, test } from "bun:test";
import { AppId, AppRef, AppWindow, SessionId } from "@polaris/protocol";
import { Effect, Layer, Option } from "effect";
import { PreviewSource } from "./source.ts";
import { fit, stillImage, stillLayer } from "./still.ts";
import { PreviewTargets } from "./targets.ts";

const session = SessionId.make("s1");

const app = new AppRef({ id: AppId.make("org.gnome.TextEditor"), name: "Text Editor" });

const window = new AppWindow({ id: "41", title: "notes.txt" });

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

/** A real PNG of the given size, as a screenshot tool would hand over. */
const png = (width: number, height: number) =>
  new Bun.Image(ONE_PIXEL_PNG).resize(width, height).png().bytes();

const screenshot = async (width: number, height: number) => ({
  app,
  window,
  image: await png(width, height),
  takenAt: 1_794_000_000_000,
});

test.each([
  [1600, 900, 640, 640, 360],
  [900, 1600, 640, 360, 640],
  [300, 200, 640, 300, 200],
])("a %dx%d screenshot asked for at %d is a %dx%d JPEG", async (width, height, edge, w, h) => {
  const image = Option.getOrThrow(
    await Effect.runPromise(stillImage(await screenshot(width, height), edge))
  );

  expect(await new Bun.Image(image.jpeg).metadata()).toMatchObject({
    format: "jpeg",
    width: w,
    height: h,
  });
  expect([image.width, image.height, image.capturedAt, image.app, image.window]).toEqual([
    w,
    h,
    1_794_000_000_000,
    app,
    window,
  ]);
});

test("a screenshot that fits no quality, or is no image, is no preview", async () => {
  const real = await screenshot(800, 600);
  const junk = { ...real, image: new Uint8Array([1, 2, 3]) };

  expect(await Effect.runPromise(stillImage(real, 640, 16))).toEqual(Option.none());
  expect(await Effect.runPromise(stillImage(junk, 640))).toEqual(Option.none());
});

test("fit never enlarges and never rounds a side to nothing", () => {
  expect([fit(100, 50, 640), fit(5000, 1, 640)]).toEqual([
    { width: 100, height: 50 },
    { width: 640, height: 1 },
  ]);
});

test("latest is the session's last screenshot, and none before its first", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* PreviewSource;
      const targets = yield* PreviewTargets;
      expect(source.live).toBe(false);
      expect(yield* source.latest({ sessionId: session, edge: 640 })).toEqual(Option.none());

      const image = yield* Effect.promise(() => png(800, 400));
      // A whole-screen capture names no window.
      yield* targets.acted(session, { app, window: null, screenshot: { image, takenAt: 5 } });
      const latest = Option.getOrThrow(yield* source.latest({ sessionId: session, edge: 320 }));

      expect([latest.width, latest.height, latest.window, latest.capturedAt]).toEqual([
        320,
        160,
        null,
        5,
      ]);
    }).pipe(Effect.provide(stillLayer.pipe(Layer.provideMerge(PreviewTargets.layer))))
  ));
