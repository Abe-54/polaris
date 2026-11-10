import { describe, expect, test } from "bun:test";
import { freshFrames, mjpegParser } from "./mjpeg.ts";

const part = (jpeg: ReadonlyArray<number>) =>
  Buffer.concat([
    Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
    Buffer.from(jpeg),
    Buffer.from("\r\n"),
  ]);

const framesOf = (read: ReturnType<ReturnType<typeof mjpegParser>["push"]>) =>
  read.kind === "frames" ? read.frames.map((f) => [...f]) : read.kind;

// A JPEG whose bytes contain the boundary text, which Content-Length must carry past.
const tricky = [0xff, 0xd8, ...Buffer.from("\r\n--frame\r\n"), 0xff, 0xd9];

const body = Buffer.concat([
  part([0xff, 0xd8, 1, 0xff, 0xd9]),
  part(tricky),
  part([0xff, 0xd8, 2, 0xff, 0xd9]),
]);

describe("mjpegParser", () => {
  test("reads each part's JPEG by its length, even with the boundary inside it", () => {
    expect(framesOf(mjpegParser().push(body))).toEqual([
      [0xff, 0xd8, 1, 0xff, 0xd9],
      tricky,
      [0xff, 0xd8, 2, 0xff, 0xd9],
    ]);
  });

  test.each([1, 3, 10])("gives the same frames when bytes arrive %i at a time", (size) => {
    const parser = mjpegParser();
    const seen: Array<unknown> = [];

    for (let at = 0; at < body.length; at += size) {
      const read = parser.push(body.subarray(at, at + size));

      if (read.kind === "frames") seen.push(...read.frames.map((f) => [...f]));
    }

    expect<unknown>(seen).toEqual(framesOf(mjpegParser().push(body)));
  });

  test("a part without Content-Length is refused", () => {
    expect(
      mjpegParser().push(Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\nxx")).kind
    ).toBe("invalid");
  });

  test("bytes that never reach a boundary are refused", () => {
    expect(mjpegParser().push(new Uint8Array(5000)).kind).toBe("invalid");
  });
});

describe("freshFrames", () => {
  test("skips only the first frame of a connection, the stale cached one", () => {
    const fresh = freshFrames();
    const a = Uint8Array.of(1);
    const b = Uint8Array.of(2);
    const c = Uint8Array.of(3);

    expect(fresh([])).toEqual([]);
    expect(fresh([a, b])).toEqual([b]);
    expect(fresh([c])).toEqual([c]);
  });
});
