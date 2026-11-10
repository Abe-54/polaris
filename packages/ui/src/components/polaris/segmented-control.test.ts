import { describe, expect, test } from "bun:test";

import { pillClip } from "./segmented-control";

describe("the segmented control's pill", () => {
  test("is the selected segment's box, as a share of the whole track", () => {
    const track = { width: 200, height: 36 };

    expect(pillClip(track, { left: 73, top: 3, width: 60, height: 30 })).toBe(
      "inset(8.333% 33.5% 8.333% 36.5% round 999px)"
    );
  });

  test("covers the track when one segment fills it", () => {
    const track = { width: 120, height: 28 };

    expect(pillClip(track, { left: 0, top: 0, width: 120, height: 28 })).toBe(
      "inset(0% 0% 0% 0% round 999px)"
    );
  });

  test("a track with no size, as when it is hidden, has no pill", () => {
    expect(pillClip({ width: 0, height: 0 }, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
});
