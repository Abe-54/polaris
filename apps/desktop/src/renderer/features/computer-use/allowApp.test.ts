import { describe, expect, test } from "bun:test";
import { AppId } from "@polaris/protocol";
import { appIdProblem, confirmLabel, refusedWarning, typedCandidate } from "./allowApp.ts";

describe("appIdProblem", () => {
  test.each([
    ["macos", "com.apple.Safari", null],
    ["macos", "Safari", "A bundle id looks like com.apple.Safari"],
    ["macos", "  ", "Enter the app's id"],
    ["linux", "org.gnome.Nautilus", null],
    ["linux", "/usr/bin/nautilus", "A .desktop id has no slashes"],
    ["windows", "C:\\Program Files\\Paper\\Paper.exe", null],
    ["windows", "C:\\Program Files\\Paper", "A path must end in .exe"],
    ["windows", "paper", null],
  ] as const)("%s %p → %p", (platform, raw, expected) => {
    expect(appIdProblem(platform, raw)).toBe(expected);
  });
});

describe("refusedWarning", () => {
  test("warns for a terminal, a password manager, System Settings and Polaris, by id", () => {
    const warned = [
      "com.apple.Terminal",
      "com.1password.1password",
      "com.apple.systempreferences",
      "dev.lux.polaris",
    ]
      .map((id) => refusedWarning({ id: AppId.make(id), name: id }, "Mac Studio"))
      .map((warning) => warning?.title.startsWith("Polaris never lets agents use"));

    expect(warned).toEqual([true, true, true, true]);
  });

  test("says nothing for an ordinary app, whose button has no 'anyway'", () => {
    const safari = { id: AppId.make("com.apple.Safari"), name: "Safari" };

    expect(refusedWarning(safari, "Mac Studio")).toBeNull();
    expect(confirmLabel(safari, false)).toBe("Always allow Safari");
  });

  test("a typed Windows path is named by its file, and a refused one still warns", () => {
    const typed = typedCandidate(" C:\\Windows\\System32\\cmd.exe ");

    expect(typed.name).toBe("cmd.exe");
    expect(refusedWarning(typedCandidate("cmd.exe"), "win-box")?.title).toBe(
      "Polaris never lets agents use cmd.exe by default"
    );
  });
});
