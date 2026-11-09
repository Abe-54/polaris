import { describe, expect, test } from "bun:test";
import {
  fitRect,
  toFramePoint,
  toScreenPoint,
  toScreenPointClamped,
  turnedSize,
  turnsFor,
} from "./geometry.ts";

/** The iPhone Duo's outer panel at 3× (spike: 1398×2034), and an iPhone 17 Pro (1206×2622). */
const duo = { width: 1398, height: 2034 };

const pro = { width: 1206, height: 2622 };

describe("fitRect", () => {
  test("a tall screen in a wide area fills the height, centred across", () => {
    const rect = fitRect({ width: 728, height: 600 }, duo);

    expect(rect.height).toBe(600);
    expect(rect.width).toBe(412);
    expect(rect.left).toBe(158);
    expect(rect.top).toBe(0);
  });

  test("a narrow area fills the width, centred down", () => {
    const rect = fitRect({ width: 360, height: 900 }, pro);

    expect(rect).toEqual({ left: 0, top: 59, width: 360, height: 782 });
  });

  test.each([
    [{ width: 728, height: 600 }, duo],
    [{ width: 360, height: 640 }, duo],
    [{ width: 900, height: 300 }, pro],
    [
      { width: 300, height: 300 },
      { width: 2622, height: 1206 },
    ],
  ])("keeps the screen's aspect within a pixel in %o", (area, screen) => {
    const rect = fitRect(area, screen);

    expect(rect.width).toBeLessThanOrEqual(area.width);
    expect(rect.height).toBeLessThanOrEqual(area.height);
    const aspect = screen.width / screen.height;

    expect(Math.abs(rect.width / rect.height - aspect)).toBeLessThan(
      aspect * (1 / rect.height + 1 / rect.width)
    );
  });

  test("an empty area or an unknown screen size has nothing to draw into", () => {
    expect(fitRect({ width: 0, height: 500 }, duo).width).toBe(0);
    expect(fitRect({ width: 500, height: 500 }, { width: 0, height: 0 }).height).toBe(0);
  });
});

describe("toScreenPoint", () => {
  const rect = fitRect({ width: 728, height: 600 }, duo);

  test("maps the screen's corners and centre to 0, 1 and 0.5", () => {
    expect(toScreenPoint({ x: rect.left, y: rect.top }, rect)).toEqual({ x: 0, y: 0 });
    expect(toScreenPoint({ x: rect.left + rect.width, y: rect.top + rect.height }, rect)).toEqual({
      x: 1,
      y: 1,
    });
    expect(
      toScreenPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, rect)
    ).toEqual({ x: 0.5, y: 0.5 });
  });

  test("a point on the panel beside the screen is off it", () => {
    expect(toScreenPoint({ x: rect.left - 1, y: 300 }, rect)).toBeNull();
    expect(toScreenPoint({ x: rect.left + rect.width + 1, y: 300 }, rect)).toBeNull();
  });

  test("the spike's Settings tap on the 17 Pro (0.88, 0.395) lands back on itself", () => {
    const fitted = fitRect({ width: 360, height: 900 }, pro);
    const client = { x: fitted.left + 0.88 * fitted.width, y: fitted.top + 0.395 * fitted.height };
    const point = toScreenPoint(client, fitted);

    expect(point?.x).toBeCloseTo(0.88, 10);
    expect(point?.y).toBeCloseTo(0.395, 10);
  });

  test("a drag past the edge holds at the edge", () => {
    expect(
      toScreenPointClamped({ x: rect.left - 50, y: rect.top + rect.height + 50 }, rect)
    ).toEqual({
      x: 0,
      y: 1,
    });
  });
});

describe("turned frames", () => {
  test("landscape turns the portrait frame a quarter, so it fits as landscape", () => {
    expect(turnsFor("landscape_left")).toBe(1);
    expect(turnsFor("landscape_right")).toBe(3);
    expect(turnsFor(null)).toBe(0);
    expect(turnedSize(pro, turnsFor("landscape_left"))).toEqual({ width: 2622, height: 1206 });
    expect(turnedSize(pro, turnsFor("portrait_upside_down"))).toEqual(pro);
  });

  // The frame's top-left corner, as each turn shows it.
  test.each([
    [0, { x: 0, y: 0 }],
    [1, { x: 1, y: 0 }],
    [2, { x: 1, y: 1 }],
    [3, { x: 0, y: 1 }],
  ] as const)("after %i quarter turns the frame's top-left shows at %o", (turns, shown) => {
    expect(toFramePoint(shown, turns)).toEqual({ x: 0, y: 0 });
  });
});
