import { describe, expect, test } from "bun:test";
import { finding } from "./daemon.testing.ts";
import { canReview, chipAction, suggestions } from "./suggestions.ts";

describe("suggested chips", () => {
  test("after a finished Turn, Open review opens the session's Review route", () => {
    const chips = suggestions({ state: "idle", lastTurn: "completed", findings: [] });
    const review = chips.find((chip) => chip.kind === "review");
    expect(review === undefined ? null : chipAction(review, "h-1", "s-1")).toEqual({
      kind: "open",
      route: { screen: "review", hostId: "h-1", sessionId: "s-1", turnId: null },
    });
  });

  test("Fix the critical finding fills the composer instead", () => {
    const [fix] = suggestions({ state: "idle", lastTurn: "failed", findings: [finding()] });
    expect(fix === undefined ? null : chipAction(fix, "h-1", "s-1")).toEqual({
      kind: "fill",
      text: 'Fix the critical finding "Secret-like value committed" at serve.ts:4.',
    });
  });
});

// ENG-640: Review is a button in the session's header, not where a Home row goes.
test.each([
  [[], false],
  [["working"], false],
  [["completed", "working"], true],
  [["interrupted"], true],
  [["failed"], true],
] as const)("turns %p can be reviewed: %p", (turns, expected) => {
  expect(canReview(turns)).toBe(expected);
});
