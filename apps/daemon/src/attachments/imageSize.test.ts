import { describe, expect, test } from "bun:test";
import { imageSize } from "./imageSize.ts";
import { bytes, PNG_1200x800, tag, u16le, u24le, zeros } from "./imageSize.testing.ts";

const riff = (kind: string) => [...tag("RIFF"), 0, 0, 0, 0, ...tag("WEBP"), ...tag(kind)];

describe("imageSize", () => {
  const app0 = [0xff, 0xe0, 0, 6, 1, 2, 3, 4];
  const sof0 = [0xff, 0xc0, 0, 17, 8, 3, 0x20, 2, 0x80, 3];
  const bits = 99 | (49 << 14);

  test.each([
    ["PNG", PNG_1200x800, 1200, 800],
    ["GIF", bytes(tag("GIF89a"), u16le(64), u16le(32)), 64, 32],
    ["JPEG skips segments before its frame", bytes([0xff, 0xd8], app0, sof0, zeros(10)), 640, 800],
    [
      "WebP, extended",
      bytes(riff("VP8X"), [10, 0, 0, 0], zeros(4), u24le(1919), u24le(1079)),
      1920,
      1080,
    ],
    [
      "WebP, lossless",
      bytes(riff("VP8L"), [5, 0, 0, 0, 0x2f], u24le(bits), [bits >>> 24], zeros(8)),
      100,
      50,
    ],
  ] as const)("%s", (_name, image, width, height) => {
    expect(imageSize(image)).toEqual({ width, height });
  });

  test("anything else, or a truncated header, is null", () => {
    expect(imageSize(bytes(tag("%PDF-1.7")))).toBeNull();
    expect(imageSize(PNG_1200x800.slice(0, 20))).toBeNull();
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 200]))).toBeNull();
  });
});
