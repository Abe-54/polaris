import { describe, expect, test } from "bun:test";
import type { Route } from "../app/route.ts";
import { arrangementOf, composerMinHeight } from "./arrangement.ts";
import { FOLDED, type Posture } from "./posture.ts";

const unfolded: Posture = {
  kind: "unfolded",
  first: { x: 0, y: 0, width: 455.5, height: 669 },
  second: { x: 495.5, y: 0, width: 455.5, height: 669 },
  division: { x: 455.5, y: 0, width: 40, height: 669 },
};

const halfFolded: Posture = {
  kind: "halfFolded",
  top: { x: 0, y: 0, width: 669, height: 455.5 },
  bottom: { x: 0, y: 495.5, width: 669, height: 455.5 },
  division: { x: 0, y: 455.5, width: 669, height: 40 },
};

const thread: Route = { screen: "thread", hostId: "h", sessionId: "s" };

const constellation: Route = { screen: "constellation", hostId: "h", constellationId: "c" };

const home: Route = { screen: "tabs" };

const review: Route = { screen: "review", hostId: "h", sessionId: "s", turnId: null };

describe("arrangementOf", () => {
  test.each([thread, constellation, home, review])("folded, %o is the iPhone app", (route) => {
    expect(arrangementOf(FOLDED, route).kind).toBe("single");
  });

  test.each([
    [thread, "context"],
    [constellation, "span"],
    [home, "aside"],
    [review, "aside"],
  ] as const)("unfolded, %o is %s", (route, kind) => {
    expect(arrangementOf(unfolded, route).kind).toBe(kind);
  });

  test("unfolded, the constellation's chart and claim take the two halves", () => {
    expect(arrangementOf(unfolded, constellation)).toEqual({
      kind: "span",
      first: { x: 0, y: 0, width: 455.5, height: 669 },
      second: { x: 495.5, y: 0, width: 455.5, height: 669 },
    });
  });

  test.each([
    [thread, "laptop"],
    [home, "monitor"],
    [constellation, "single"],
    [review, "single"],
  ] as const)("half-folded, %o is %s", (route, kind) => {
    expect(arrangementOf(halfFolded, route).kind).toBe(kind);
  });
});

describe("composerMinHeight", () => {
  const bottom = { x: 0, y: 495.5, width: 669, height: 455.5 };
  const division = { x: 0, y: 455.5, width: 669, height: 40 };

  test("with the keyboard up, the composer fills from the fold down to it", () => {
    expect(composerMinHeight(bottom, division, 291, 34)).toBe(455.5 + 40 - 291);
  });

  test("with it down, from the fold to the home indicator", () => {
    expect(composerMinHeight(bottom, division, 0, 34)).toBe(455.5 + 40 - 34);
  });

  test("a keyboard taller than the bottom half leaves no minimum", () => {
    expect(composerMinHeight(bottom, division, 600, 34)).toBe(0);
  });
});
