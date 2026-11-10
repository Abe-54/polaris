import { describe, expect, test } from "bun:test";

import { splitAt, springSteps } from "./morph.ts";

/** How far above the strip's top edge each moving edge is, from a split's numbers. */
const edges = (height: number, split: number) => {
  const at = splitAt(height, split);

  return { terminalTop: height + 6 - at.drop, cardEdge: at.lift };
};

describe("the editor's terminal morph", () => {
  test("starts as one card: the terminal is wholly below the strip's top edge", () => {
    const { terminalTop, cardEdge } = edges(280, 0);

    expect(terminalTop).toBe(0);
    expect(cardEdge).toBe(0);
    expect(splitAt(280, 0)).toMatchObject({ edge: 0, top: 0, bottom: 18 });
  });

  test("ends divided: the terminal at rest, 6px under the editor card, the strip round", () => {
    const { terminalTop, cardEdge } = edges(280, 1);

    expect(splitAt(280, 1).drop).toBe(0);
    expect(cardEdge - terminalTop).toBe(6);
    expect(splitAt(280, 1)).toMatchObject({ edge: 18, top: 12, bottom: 12 });
  });

  test.each([0.1, 0.5, 0.9])("the cards never touch on the way (split %p)", (split) => {
    const { terminalTop, cardEdge } = edges(280, split);

    expect(cardEdge - terminalTop).toBeCloseTo(6 * split, 6);
  });

  test("past the end, only the terminal moves; the shapes stay at rest", () => {
    expect(splitAt(280, 1.01).drop).toBeLessThan(0);
    expect(splitAt(280, 1.01)).toMatchObject({ lift: 292, edge: 18, top: 12, bottom: 12 });
  });

  test("the spring runs from the given split to rest", () => {
    const steps = springSteps(286, 0);

    expect(steps[0]).toBe(0);
    expect(steps.at(-1)).toBe(1);
    expect(springSteps(286, 0.4)[0]).toBeCloseTo(0.4, 6);
    expect(springSteps(286, 0.4).at(-1)).toBe(1);
  });

  test("a short travel keeps the spring's own overshoot", () => {
    expect(Math.max(...springSteps(126, 0))).toBeCloseTo(1.015, 6);
  });

  test("a long travel overshoots by 4px at most", () => {
    const travel = 1100;
    const peak = Math.max(...springSteps(travel, 0));

    expect(peak).toBeGreaterThan(1);
    expect((peak - 1) * travel).toBeCloseTo(4, 6);
  });
});
