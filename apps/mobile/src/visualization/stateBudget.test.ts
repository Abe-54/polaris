import { describe, expect, test } from "bun:test";
import { evictions, STATES_MAX_BYTES, STATES_MAX_FILES } from "./stateBudget.ts";

const file = (name: string, size: number, modified: number) => ({ name, size, modified });

describe("the total pv.state on the phone", () => {
  test("within both caps nothing is deleted", () => {
    expect(evictions([file("a", 10, 1), file("b", 10, 2)], "b")).toEqual([]);
  });

  test("past the byte cap the least recently written go first", () => {
    const size = STATES_MAX_BYTES / 4;
    const files = [file("c", size, 3), file("a", size, 1), file("b", size, 2), file("d", size, 4)];

    expect(evictions([...files, file("e", size, 5)], "e")).toEqual(["a"]);
  });

  test("past the file cap the oldest go, and the one just written stays even if oldest", () => {
    const files = Array.from({ length: STATES_MAX_FILES + 2 }, (_, n) => file(`f${n}`, 1, n));

    expect(evictions(files, "f0")).toEqual(["f1", "f2"]);
  });
});
