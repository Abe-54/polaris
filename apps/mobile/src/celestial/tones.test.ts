import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CELESTIAL_LASER } from "@polaris/ui/celestial";
import { midnight } from "@polaris/ui/tokens";
import { celestialPalette, harnessColour, mixOklab, TONE_MIX } from "./tones.ts";

const css = readFileSync(
  new URL("../../../../packages/ui/src/styles/celestial.css", import.meta.url).pathname,
  "utf8"
);

/** The Desktop App's tone fills, read from celestial.css: `tone → [hue share, white|black]`. */
type Mix = { readonly hue: number; readonly with: string };

const desktopMixes = (): Record<string, Mix> =>
  Object.fromEntries<Mix>(
    [...css.matchAll(/\.polaris-celestial-(\w+)\s*\{\s*fill:\s*([^;]+);/g)].map(
      ([, tone, fill]) => {
        const mix = /color-mix\(in oklab, var\(--celestial-hue\) (\d+)%, (white|black)\)/.exec(
          fill ?? ""
        );

        return [
          tone ?? "",
          mix === null
            ? { hue: 1, with: "white" }
            : { hue: Number(mix[1]) / 100, with: mix[2] ?? "" },
        ];
      }
    )
  );

describe("celestial tones", () => {
  test("mix the hue as the Desktop App's celestial.css does, tone for tone", () => {
    expect<Record<string, Mix>>({ ...TONE_MIX }).toEqual(desktopMixes());
  });

  // Chrome's computed sRGB for `color-mix(in oklab, a p%, b)`, painted to a canvas.
  test.each([
    ["#d97757", 0.62, "#ffffff", "#ebab97"],
    ["#d97757", 0.62, "#000000", "#713b2a"],
    ["#d97757", 0.22, "#ffffff", "#f9e1d9"],
    ["#6fcba0", 0.62, "#000000", "#376952"],
    ["#e59ac1", 0.22, "#ffffff", "#fbe9f1"],
    ["#ffffff", 0.5, "#000000", "#636363"],
  ])("color-mix(in oklab, %s %p, %s) is the browser's %s", (a, share, b, browser) => {
    expect(mixOklab(a, share, b)).toBe(browser);
  });

  test("a Harness's palette is its theme hue's four tones; an unknown one is neutral", () => {
    expect(celestialPalette(harnessColour(midnight, "claude"))).toEqual({
      light: "#ebab97",
      hue: midnight.harnessClaudeCode,
      shade: "#713b2a",
      glint: "#f9e1d9",
      laser: CELESTIAL_LASER,
    });
    expect(harnessColour(midnight, "codex")).toBe(midnight.harnessCodex);
    expect(harnessColour(midnight, "opencode")).toBe(midnight.harnessOpencode);
    expect(harnessColour(midnight, "gemini")).toBe(midnight.textSubtle);
    expect(harnessColour(midnight, "from-a-newer-daemon")).toBe(midnight.textSubtle);
  });
});
