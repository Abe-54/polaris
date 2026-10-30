import { describe, expect, test } from "bun:test";
import { captureRect, htmlExcerpt } from "./index.ts";

describe("the pick's capture", () => {
  test("covers the element's fractional bounds whole, at the page's zoom", () => {
    expect(captureRect({ x: 10.4, y: 0.5, width: 100.2, height: 20 }, 1)).toEqual({
      x: 10,
      y: 0,
      width: 101,
      height: 21,
    });
    expect(captureRect({ x: 10, y: 20, width: 100, height: 40 }, 1.5)).toEqual({
      x: 15,
      y: 30,
      width: 150,
      height: 60,
    });
  });

  test("an element with nothing on screen has no capture", () => {
    expect(captureRect({ x: 0, y: 0, width: 0, height: 30 }, 1)).toBeNull();
  });

  test("cut HTML says how much is missing", () => {
    expect(htmlExcerpt("<div>ab", 20)).toBe("<div>ab\n<!-- 13 more characters not included -->");
    expect(htmlExcerpt("<b>x</b>", 8)).toBe("<b>x</b>");
  });
});
