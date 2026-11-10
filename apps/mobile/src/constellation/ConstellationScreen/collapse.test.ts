import { describe, expect, test } from "bun:test";
import { headerCollapsed } from "./collapse.ts";

describe("the constellation header on scroll", () => {
  test("folds once the thread scrolls back, and opens again at the newest turn", () => {
    let collapsed = false;

    const states = [0, 10, 40, 200, 12, 2].map((offset) => {
      collapsed = headerCollapsed(collapsed, offset);

      return collapsed;
    });

    expect(states).toEqual([false, false, true, true, true, false]);
  });
});
