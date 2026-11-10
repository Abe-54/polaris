import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { MORPH_EASE, MORPH_MS } from "./motion";

/** Whitespace removed, so a reformatted token still matches. */
const squash = (text: string) => text.replace(/\s+/g, "");

const tokens = squash(readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8"));

const stops = MORPH_EASE.slice("linear(".length, -1).split(",").map(Number);

describe("the morph spring", () => {
  test("CSS and the Web Animations API share one curve and one duration", () => {
    expect(tokens).toContain(squash(`--duration-morph: ${MORPH_MS}ms;`));
    expect(tokens).toContain(squash(`--ease-morph: ${MORPH_EASE};`));
  });

  test("it overshoots slightly and settles exactly at rest", () => {
    const peak = Math.max(...stops);

    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(1);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(1.02);
  });
});
