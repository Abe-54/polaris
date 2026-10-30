import { describe, expect, test } from "bun:test";
import type { AppUpdateView } from "../../../../shared/appUpdates.ts";
import { appUpdateRow } from "./model.ts";

const view = (patch: Partial<AppUpdateView> = {}): AppUpdateView => ({
  phase: "idle",
  version: "0.4.0",
  availableVersion: null,
  automatic: true,
  lastCheckedAt: null,
  installId: "58baf1dc-3772-4353-86b3-3a8a49219521",
  osVersion: "26.1",
  arch: "arm64",
  supported: true,
  ...patch,
});

describe("About Update states", () => {
  test("Windows install guidance names Setup.exe", () => {
    expect(appUpdateRow(view({ platform: "win32", phase: "blocked" })).caption).toBe(
      "Install Polaris with Setup.exe, then check again"
    );
    expect(appUpdateRow(view({ platform: "win32", supported: false })).title).toContain(
      "installed Windows app"
    );
  });

  test("the reveal action names each platform's file manager", () => {
    const label = (platform: string) =>
      appUpdateRow(view({ platform, phase: "blocked" })).actionLabel;

    expect(label("darwin")).toBe("Show in Finder");
    expect(label("win32")).toBe("Show in Explorer");
    expect(label("linux")).toBe("Show in folder");
  });

  test("available metadata is absent until macOS finishes downloading", () => {
    expect(appUpdateRow(view({ phase: "downloading" }))).toMatchObject({
      title: "Downloading Polaris",
      glyph: "working",
      action: null,
    });
    expect(appUpdateRow(view({ phase: "blocked" }))).toMatchObject({
      title: "Polaris can't install here",
      action: "finder",
    });
  });
  test("checks off still lets the user check, and retains ready updates", () => {
    expect(appUpdateRow(view({ automatic: false }))).toMatchObject({
      title: "Automatic checks are off",
      action: "check",
    });
    expect(
      appUpdateRow(view({ automatic: false, phase: "ready", availableVersion: "0.5.0" }))
    ).toMatchObject({
      title: "Polaris 0.5.0 is ready",
      action: "restart",
      caption: "Installs when you restart or quit; agent sessions keep working",
    });
  });
  test("failures stay neutral and never promise an automatic retry with checks off", () => {
    expect(appUpdateRow(view({ phase: "failed", automatic: false }))).toMatchObject({
      glyph: "failed",
      actionLabel: "Try again",
    });
    expect(appUpdateRow(view({ phase: "failed", automatic: false })).caption).not.toContain(
      "6 hours"
    );
  });
  test("working states offer no second action", () => {
    for (const phase of ["checking", "downloading"] as const)
      expect(appUpdateRow(view({ phase })).action).toBeNull();
  });
  test("no caption repeats the footer's last-checked time", () => {
    const at = Date.UTC(2026, 9, 30, 14, 2);

    for (const automatic of [true, false]) {
      const caption = appUpdateRow(
        view({ phase: "current", automatic, lastCheckedAt: at })
      ).caption;

      expect(caption).not.toMatch(/checked/i);
    }
  });
});
