import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const RENDERER = fileURLToPath(new URL("..", import.meta.url));

/** Every class string in the renderer's own UI that paints `bg-bg` on something other than a field. */
const bgBgSurfaces = async () => {
  const found: string[] = [];

  for await (const path of new Glob("**/*.tsx").scan(RENDERER)) {
    if (/\.test\.|testing|\/preview\//.test(path)) continue;
    const lines = (await Bun.file(`${RENDERER}${path}`).text()).split("\n");

    lines.forEach((line, i) => {
      if (/\bbg-bg\b/.test(line) && !line.includes("rounded-control"))
        found.push(`${path}:${i + 1}`);
    });
  }

  return found;
};

describe("surfaces in the new chrome", () => {
  // Moonlit's bg equals its panel, so a bg-bg surface only shows in Midnight: pure black in a #0A0B0D panel.
  test("bg-bg fills only form fields; panels and their contents use the panel, ground or well tokens", async () => {
    expect(await bgBgSurfaces()).toEqual([]);
  });
});
