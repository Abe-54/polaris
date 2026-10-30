import { describe, expect, test } from "bun:test";
import {
  HOME_TABS,
  initialNavigation,
  layersOf,
  opened,
  pushed,
  replaced,
  selected,
  topOf,
  wentBack,
} from "./navigationState.ts";

describe("the tabs", () => {
  test("the pill holds Sessions, Review and Settings; Hosts is no longer a tab", () => {
    expect(HOME_TABS).toEqual(["sessions", "review", "settings"]);
  });
});

describe("Settings → Hosts", () => {
  test("Hosts pushes over Settings and back returns to the Settings tab", () => {
    const onSettings = selected(initialNavigation, "settings");
    const onHosts = pushed(onSettings, { screen: "hosts" });

    expect(topOf(onHosts)).toEqual({ screen: "hosts" });

    const back = wentBack(onHosts);

    expect(topOf(back)).toEqual({ screen: "tabs" });
    expect(back.tab).toBe("settings");
  });

  test("a widget link from Settings lands on Sessions", () => {
    const onHosts = pushed(selected(initialNavigation, "settings"), { screen: "hosts" });
    const linked = opened(onHosts, { screen: "thread", hostId: "h", sessionId: "s" });

    expect(linked.tab).toBe("sessions");
    expect(linked.stack).toEqual([
      { screen: "tabs" },
      { screen: "thread", hostId: "h", sessionId: "s" },
    ]);
  });
});

describe("New session", () => {
  test("once it starts, its thread takes its place: back returns to the tab it opened from", () => {
    const onReview = selected(initialNavigation, "review");
    const writing = pushed(onReview, { screen: "newSession", workspaceId: null });
    const thread = { screen: "thread", hostId: "h", sessionId: "s", rise: true } as const;
    const started = replaced(writing, thread);

    expect(started.stack).toEqual([{ screen: "tabs" }, thread]);
    expect(topOf(wentBack(started))).toEqual({ screen: "tabs" });
    expect(wentBack(started).tab).toBe("review");
  });
});

describe("the screens drawn", () => {
  test("a pushed screen sits over the one beneath, which keeps its key through push and back", () => {
    const thread = { screen: "thread", hostId: "h", sessionId: "s" } as const;
    const constellation = { screen: "constellation", hostId: "h", constellationId: "c" } as const;
    const onThread = pushed(initialNavigation, thread);
    const onConstellation = pushed(onThread, constellation);

    expect(layersOf(initialNavigation)).toEqual([{ route: { screen: "tabs" }, index: 0 }]);
    expect(layersOf(onThread)).toEqual([
      { route: { screen: "tabs" }, index: 0 },
      { route: thread, index: 1 },
    ]);
    expect(layersOf(onConstellation)).toEqual([
      { route: thread, index: 1 },
      { route: constellation, index: 2 },
    ]);
    expect(layersOf(wentBack(onConstellation))).toEqual(layersOf(onThread));
  });
});
