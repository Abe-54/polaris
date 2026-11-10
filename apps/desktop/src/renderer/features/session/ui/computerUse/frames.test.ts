import { expect, test } from "bun:test";
import { framePainter } from "./frames.ts";

/** A decode the test finishes by hand, one frame at a time. */
const manualDecode = () => {
  const pending: Array<{ bytes: Uint8Array; finish: () => void }> = [];

  return {
    pending,
    decode: (bytes: Uint8Array) =>
      new Promise<string>((resolve) => {
        pending.push({ bytes, finish: () => resolve(`image ${bytes[0]}`) });
      }),
    finishNext: async () => {
      pending.shift()?.finish();
      // Let the painter's `finally` start the next decode.
      await Bun.sleep(0);
    },
  };
};

const frame = (n: number) => new Uint8Array([n]);

test("frames that arrive during a decode are dropped for the newest, never queued", async () => {
  const decoding = manualDecode();
  const painted: Array<string> = [];
  const painter = framePainter({ decode: decoding.decode, paint: (i) => painted.push(i) });

  for (const n of [1, 2, 3, 4]) painter.push(frame(n));
  await decoding.finishNext();
  await decoding.finishNext();

  expect(painted).toEqual(["image 1", "image 4"]);
  expect(decoding.pending).toEqual([]);
});

test("after close, nothing more paints and a late image is freed", async () => {
  const decoding = manualDecode();
  const painted: Array<string> = [];
  const freed: Array<string> = [];

  const painter = framePainter({
    decode: decoding.decode,
    paint: (i) => painted.push(i),
    discard: (i) => freed.push(i),
  });

  painter.push(frame(1));
  painter.push(frame(2));
  painter.close();
  await decoding.finishNext();
  painter.push(frame(3));

  expect([painted, freed, decoding.pending.length]).toEqual([[], ["image 1"], 0]);
});
