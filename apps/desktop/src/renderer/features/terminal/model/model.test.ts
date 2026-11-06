import { describe, expect, test } from "bun:test";
import { argvOf, baseName, endedLine } from "./launch.ts";
import {
  clampHeight,
  type Drawer,
  emptyDrawer,
  holdsProcess,
  MIN_HEIGHT,
  patchTab,
  persisted,
  putTab,
  removeTab,
  SHELL_TAB,
  type TerminalTab,
} from "./tabs.ts";

const tab = (key: string, patch: Partial<TerminalTab> = {}): TerminalTab => ({
  key,
  title: key,
  cwd: "/home/me/polaris",
  argv: null,
  sessionId: null,
  terminalId: `t-${key}`,
  status: { kind: "live" },
  ...patch,
});

const withTabs = (...keys: ReadonlyArray<string>): Drawer =>
  keys.reduce((d, k) => putTab(d, tab(k)), emptyDrawer);

describe("drawer tabs", () => {
  test("putting a tab opens the drawer on it", () => {
    const drawer = putTab(emptyDrawer, tab(SHELL_TAB));

    expect(drawer.open).toBe(true);
    expect(drawer.active).toBe(SHELL_TAB);
    expect(drawer.tabs).toHaveLength(1);
  });

  test("a reopen replaces the tab in place", () => {
    const drawer = putTab(withTabs("a", "b"), tab("a", { terminalId: "t-new" }));

    expect(drawer.tabs.map((t) => t.key)).toEqual(["a", "b"]);
    expect(drawer.tabs[0]?.terminalId).toBe("t-new");
    expect(drawer.active).toBe("a");
  });

  test("removing the active tab activates its left neighbour, else the right one", () => {
    expect(removeTab(withTabs("a", "b", "c"), "c").active).toBe("b");
    expect(removeTab({ ...withTabs("a", "b"), active: "a" }, "a").active).toBe("b");
  });

  test("removing the last tab closes the drawer", () => {
    const drawer = removeTab(withTabs("a"), "a");

    expect(drawer.open).toBe(false);
    expect(drawer.active).toBeNull();
  });

  test("patching a status leaves the other tabs alone", () => {
    const drawer = patchTab(withTabs("a", "b"), "b", { status: { kind: "exited", code: 1 } });

    expect(drawer.tabs.map((t) => t.status.kind)).toEqual(["live", "exited"]);
  });

  test("only tabs with a terminal hold a process", () => {
    expect(holdsProcess(tab("a"))).toBe(true);
    expect(holdsProcess(tab("a", { terminalId: null, status: { kind: "opening" } }))).toBe(false);
    expect(holdsProcess(tab("a", { status: { kind: "failed", message: "no" } }))).toBe(false);
  });

  test("persisting keeps terminals to reattach and drops the rest", () => {
    const drawer = putTab(
      patchTab(withTabs("a", "b"), "a", { status: { kind: "exited", code: 0 } }),
      tab("c", { terminalId: null, status: { kind: "opening" } })
    );

    const kept = persisted(drawer);

    expect(kept.tabs.map((t) => t.key)).toEqual(["a", "b"]);
    expect(kept.tabs.every((t) => t.status.kind === "live")).toBe(true);
  });

  test("the height leaves room for the pane above", () => {
    expect(clampHeight(50, 800)).toBe(MIN_HEIGHT);
    expect(clampHeight(900, 800)).toBe(800 - MIN_HEIGHT);
    expect(clampHeight(300.4, 800)).toBe(300);
  });
});

describe("launch", () => {
  test("no environment runs the argv as is", () => {
    expect(argvOf({ argv: ["claude", "--resume", "x"], cwd: "/", env: {} })).toEqual([
      "claude",
      "--resume",
      "x",
    ]);
  });

  test("variables ride in front through env(1)", () => {
    expect(argvOf({ argv: ["codex"], cwd: "/", env: { A: "1", B: "two words" } })).toEqual([
      "env",
      "A=1",
      "B=two words",
      "--",
      "codex",
    ]);
  });

  test("how a terminal ended reads plainly", () => {
    expect(endedLine({ kind: "live" })).toBeNull();
    expect(endedLine({ kind: "exited", code: 0 })).toBe("Process exited");
    expect(endedLine({ kind: "exited", code: 2 })).toBe("Process exited with code 2");
    expect(endedLine({ kind: "exited", code: null })).toMatch(/daemon restarted/);
  });

  test("a terminal lost with an upgraded Daemon says so, and a signal doesn't blame it", () => {
    const stop = { reason: "upgrade", fromVersion: "0.2.0", at: "2026-10-16T12:00:00.000Z" };
    const lost = { kind: "exited", code: null, lost: true } as const;

    expect(endedLine(lost, stop)).toBe(
      "This terminal ended when the daemon was upgraded from 0.2.0"
    );
    expect(endedLine(lost, { ...stop, reason: "restart" })).toBe(
      "This terminal ended when the daemon restarted"
    );
    expect(endedLine({ kind: "exited", code: null }, stop)).toMatch(/or the process was stopped/);
  });

  test.each([
    ["C:\\Users\\lucas\\code\\polaris", "polaris"],
    ["/home/me/code/polaris/", "polaris"],
    ["/", "/"],
  ])("the tab for %s is titled %s", (path, title) => {
    expect(baseName(path)).toBe(title);
  });
});
