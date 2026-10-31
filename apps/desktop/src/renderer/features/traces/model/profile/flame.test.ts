import { describe, expect, test } from "bun:test";
import type { ProfileNode } from "@polaris/protocol";
import { FIXTURE_SESSION } from "../../preview/fixtures.ts";
import { fixtureProfilesApi, LARGE_PROFILE } from "../../preview/profiles.ts";
import {
  eachVisibleFrame,
  firstRootIn,
  flameLayout,
  frameAt,
  frameMove,
  panned,
  revealed,
  zoomed,
} from "./flame.ts";

const node = (parent: number | null, startMs: number, durationMs: number): ProfileNode => ({
  parent,
  functionIndex: 0,
  startMs,
  durationMs,
});

// 0 [0,100) has 1 [0,60) (with 3 [10,20)) and 2 [60,90); 4 [100,140) is a root.
// 5 names a later parent, so it is a root too.
const NODES = [
  node(null, 0, 100),
  node(0, 0, 60),
  node(0, 60, 30),
  node(1, 10, 10),
  node(null, 100, 40),
  node(9, 150, 5),
];

const layout = flameLayout({
  nodes: NODES,
  hotFunctions: [{ name: "f", file: null, line: null, selfMs: 0, totalMs: 0 }],
});

const drawn = (window: { from: number; to: number }, width: number, top = 0, rows = 10) => {
  const nodes: Array<number> = [];

  eachVisibleFrame(layout, { window, width, top, rows }, (n) => nodes.push(n));

  return nodes;
};

describe("flameLayout", () => {
  test("orders depth-first with each subtree's extent, and a bad parent makes a root", () => {
    expect([...layout.order]).toEqual([0, 1, 3, 2, 4, 5]);
    expect([...layout.after]).toEqual([4, 3, 3, 4, 5, 6]);
    expect([...layout.depth]).toEqual([0, 1, 2, 1, 0, 0]);
    expect(layout.levels).toBe(3);
    expect(layout.endMs).toBe(155);
  });
});

describe("eachVisibleFrame", () => {
  test("skips whole subtrees outside the window, narrower than a pixel, or below the rows", () => {
    expect(drawn({ from: 0, to: 155 }, 1000)).toEqual([0, 1, 3, 2, 4, 5]);
    expect(drawn({ from: 95, to: 155 }, 1000)).toEqual([0, 4, 5]);
    // At 6 px for 155 ms, node 3's 10 ms and node 5's 5 ms are under half a pixel.
    expect(drawn({ from: 0, to: 155 }, 6)).toEqual([0, 1, 2, 4]);
    expect(drawn({ from: 0, to: 155 }, 1000, 1, 1)).toEqual([1, 2]);
  });

  test("a 50,000-node Profile draws a few thousand frames at full width, all of them nowhere", async () => {
    const answer = await fixtureProfilesApi({ large: true }).get(
      { hostKey: "local", sessionId: FIXTURE_SESSION },
      LARGE_PROFILE.id
    );

    if (!answer.ok) throw new Error(answer.error.message);
    const big = flameLayout(answer.value);
    const whole = { from: 0, to: big.endMs };

    const count = eachVisibleFrame(
      big,
      { window: whole, width: 740, top: 0, rows: 6 },
      () => undefined
    );

    expect(answer.value.nodes.length).toBe(50_000);
    expect(count).toBeLessThan(2_000);
    expect(count).toBeGreaterThan(0);
  });
});

describe("frameAt and frameMove", () => {
  test("finds the frame under a time at a level, and none in a gap", () => {
    expect([frameAt(layout, 15, 2), frameAt(layout, 70, 1), frameAt(layout, 120, 0)]).toEqual([
      3, 2, 4,
    ]);
    expect([frameAt(layout, 95, 1), frameAt(layout, 145, 0)]).toEqual([null, null]);
  });

  test("the keyboard starts on the first root inside the window, skipping earlier ones", () => {
    expect([
      firstRootIn(layout, { from: 0, to: 200 }),
      firstRootIn(layout, { from: 110, to: 200 }),
      firstRootIn(layout, { from: 141, to: 149 }),
    ]).toEqual([0, 4, null]);
  });

  test("Up, Down, Left and Right walk parent, first child and siblings", () => {
    expect(frameMove(layout, 3, "up")).toBe(1);
    expect(frameMove(layout, 0, "down")).toBe(1);
    expect(frameMove(layout, 1, "right")).toBe(2);
    expect(frameMove(layout, 2, "left")).toBe(1);
    expect(frameMove(layout, 0, "right")).toBe(4);
    expect([
      frameMove(layout, 3, "down"),
      frameMove(layout, 0, "up"),
      frameMove(layout, 2, "right"),
    ]).toEqual([null, null, null]);
  });
});

describe("zoomed and panned", () => {
  test("zoom keeps the time under the pointer in place and stays inside the recording", () => {
    expect(zoomed({ from: 0, to: 100 }, 0.5, 50, 100)).toEqual({ from: 25, to: 75 });
    expect(zoomed({ from: 0, to: 100 }, 0.5, 0, 100)).toEqual({ from: 0, to: 50 });
    expect(zoomed({ from: 25, to: 75 }, 4, 50, 100)).toEqual({ from: 0, to: 100 });
    expect(panned({ from: 10, to: 30 }, 100, 100)).toEqual({ from: 80, to: 100 });
    expect(panned({ from: 10, to: 30 }, -100, 100)).toEqual({ from: 0, to: 20 });
  });

  test("a window longer than the recording still starts at 0", () => {
    expect(panned({ from: 0, to: 12_400 }, 40, 12_310).from).toBe(0);
  });
});

describe("revealed", () => {
  test("moves the window the least that shows the frame, either way, and not if it shows", () => {
    expect(revealed(layout, { from: 30, to: 50 }, 3, 155)).toEqual({ from: 10, to: 30 });
    expect(revealed(layout, { from: 0, to: 20 }, 4, 155)).toEqual({ from: 120, to: 140 });
    const shown = { from: 15, to: 35 };

    expect(revealed(layout, shown, 3, 155)).toBe(shown);
  });
});
