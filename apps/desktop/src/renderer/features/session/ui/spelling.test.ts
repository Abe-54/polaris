import { describe, expect, test } from "bun:test";
import { wordAround } from "./spelling.ts";

const word = (text: string, offset: number) => {
  const bounds = wordAround(text, offset);

  return bounds === null ? null : text.slice(bounds.start, bounds.end);
};

describe("wordAround", () => {
  test.each([
    ["fix teh bug", 5, "teh"],
    ["fix teh bug", 4, "teh"],
    ["fix teh bug", 7, "teh"],
    ["don't stop", 2, "don't"],
    ["'quoted' word", 3, "quoted"],
    ["naïve café", 8, "café"],
    ["end.", 3, "end"],
  ])("in %p at %p it is %p", (text, offset, expected) => {
    expect(word(text, offset)).toBe(expected);
  });

  test.each([
    ["a  b", 2],
    ["x = 42", 3],
    ["''", 1],
  ])("in %p at %p there is none", (text, offset) => {
    expect(word(text, offset)).toBeNull();
  });
});
