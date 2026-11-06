import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { midnight } from "../../ui/src/tokens/midnight.ts";
import {
  FRAME_TOKEN_NAMES,
  FRAME_TOKEN_SOURCES,
  FRAME_TOKEN_THEMES,
  type FrameTokenName,
} from "./tokens.ts";

const tokensCss = readFileSync(join(import.meta.dir, "../../ui/src/styles/tokens.css"), "utf8");

/** A custom property's light and dark (Moonlit) values in @polaris/ui's tokens.css. */
const uiValue = (property: string): { light: string; moonlit: string } => {
  const match = new RegExp(`${property}:\\s*([^;]+);`).exec(tokensCss);

  if (match === null) throw new Error(`${property} is not in tokens.css`);
  const value = (match[1] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const pair = /^light-dark\(\s*([^,]+),\s*([^)]+)\)$/.exec(value);

  return pair === null
    ? { light: value, moonlit: value }
    : { light: (pair[1] ?? "").trim(), moonlit: (pair[2] ?? "").trim() };
};

/** `--color-text-strong` → midnight's `textStrong`. */
const midnightValue = (property: string): string | undefined => {
  const key = property
    .replace(/^--color-/, "")
    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

  // SAFETY: every midnight value is a string; the lookup misses (undefined) for a key it lacks.
  return (midnight as Readonly<Record<string, string>>)[key]?.toLowerCase();
};

const sourced: ReadonlyArray<readonly [FrameTokenName, string]> = FRAME_TOKEN_NAMES.flatMap(
  (name) => {
    const source = FRAME_TOKEN_SOURCES[name];

    return source === undefined ? [] : [[name, source] as const];
  }
);

describe("frame token themes", () => {
  test.each(sourced)(
    "%s matches @polaris/ui's %s in light, Moonlit and Midnight",
    (name, source) => {
      expect({
        light: FRAME_TOKEN_THEMES.light[name],
        moonlit: FRAME_TOKEN_THEMES.moonlit[name],
        midnight: FRAME_TOKEN_THEMES.midnight[name],
      }).toEqual({
        ...uiValue(source),
        midnight: midnightValue(source) ?? "missing from midnight.ts",
      });
    }
  );
});
