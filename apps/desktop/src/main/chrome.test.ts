import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromeOptions, menuKeys, titleBarOverlay } from "./chrome.ts";

const styles = join(import.meta.dir, "../../../../packages/ui/src/styles");

const tokens = readdirSync(styles)
  .filter((file) => file.endsWith(".css"))
  .map((file) => readFileSync(join(styles, file), "utf8"))
  .join("\n");

/** A `light-dark(light, dark)` colour token from the design system's stylesheets. */
const token = (name: string, dark: boolean) => {
  const match = new RegExp(`--color-${name}: light-dark\\((#[0-9a-f]+), (#[0-9a-f]+)\\)`).exec(
    tokens
  );

  return (dark ? match?.[2] : match?.[1])?.toUpperCase();
};

describe("chromeOptions", () => {
  test("macOS and Linux keep the inset traffic lights", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(chromeOptions(platform, true)).toEqual({
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 16, y: 19 },
      });
    }
  });

  test("Windows hides the frame and overlays the caption buttons on our bar", () => {
    const options = chromeOptions("win32", false);

    expect(options.titleBarStyle).toBe("hidden");
    expect(options.titleBarOverlay).toEqual(titleBarOverlay(false));
    expect(options).not.toHaveProperty("trafficLightPosition");
  });
});

describe("titleBarOverlay", () => {
  test.each([true, false])("matches the title bar's tokens exactly (dark: %p)", (dark) => {
    const overlay = titleBarOverlay(dark);

    expect(overlay.color).toBe(token("ground", dark));
    expect(overlay.symbolColor).toBe(token("text-default", dark));
  });
});

describe("menuKeys", () => {
  const key = (
    type: string,
    k: string,
    mods: Partial<Record<"alt" | "control" | "shift" | "meta", boolean>> = {}
  ) => ({
    type,
    key: k,
    alt: false,
    control: false,
    shift: false,
    meta: false,
    ...mods,
  });

  test("F10 alone opens the menu; Shift+F10 stays the context menu", () => {
    const keys = menuKeys();

    expect(keys.opens(key("keyDown", "F10"))).toBe(true);
    expect(keys.opens(key("keyDown", "F10", { shift: true }))).toBe(false);
  });

  test("a lone Alt tap opens it on release", () => {
    const keys = menuKeys();

    expect(keys.opens(key("keyDown", "Alt", { alt: true }))).toBe(false);
    expect(keys.opens(key("keyUp", "Alt"))).toBe(true);
    expect(keys.opens(key("keyUp", "Alt"))).toBe(false);
  });

  test("Alt as a modifier, AltGr and Alt+Tab away don't", () => {
    const keys = menuKeys();

    keys.opens(key("keyDown", "Alt", { alt: true }));
    keys.opens(key("keyDown", "b", { alt: true }));
    expect(keys.opens(key("keyUp", "Alt"))).toBe(false);

    keys.opens(key("keyDown", "Alt", { alt: true, control: true }));
    expect(keys.opens(key("keyUp", "Alt", { control: true }))).toBe(false);

    keys.opens(key("keyDown", "Alt", { alt: true }));
    keys.reset();
    expect(keys.opens(key("keyUp", "Alt"))).toBe(false);
  });

  test("Alt+Space: the system menu's loop resets, so its Alt release opens nothing", () => {
    const keys = menuKeys();

    // The Space never reaches the page; the window sees WM_ENTERMENULOOP instead.
    keys.opens(key("keyDown", "Alt", { alt: true }));
    keys.reset();
    expect(keys.opens(key("keyUp", "Alt"))).toBe(false);
  });
});
