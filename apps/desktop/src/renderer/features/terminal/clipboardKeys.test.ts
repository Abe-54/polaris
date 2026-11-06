import { describe, expect, test } from "bun:test";
import { clipboardKey, type KeyLike } from "./clipboardKeys.ts";

const press = (key: string, mods: Partial<Omit<KeyLike, "key">> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("clipboardKey", () => {
  test.each<[string, KeyLike, "copy" | "paste" | null]>([
    ["Windows copies with Ctrl+Shift+C", press("C", { ctrlKey: true, shiftKey: true }), "copy"],
    ["Windows copies with Ctrl+Insert", press("Insert", { ctrlKey: true }), "copy"],
    ["Windows pastes with Ctrl+Shift+V", press("V", { ctrlKey: true, shiftKey: true }), "paste"],
    ["Windows pastes with Shift+Insert", press("Insert", { shiftKey: true }), "paste"],
    ["Ctrl+C still reaches the shell", press("c", { ctrlKey: true }), null],
    ["Ctrl+V still reaches the shell", press("v", { ctrlKey: true }), null],
  ])("%s", (_case, key, action) => {
    expect(clipboardKey(key, "win32")).toBe(action);
  });

  test("macOS and Linux are untouched", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(clipboardKey(press("C", { ctrlKey: true, shiftKey: true }), platform)).toBeNull();
      expect(clipboardKey(press("Insert", { shiftKey: true }), platform)).toBeNull();
    }
  });
});
