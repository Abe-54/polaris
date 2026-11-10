import { describe, expect, test } from "bun:test";
import {
  hostsClosed,
  hostsOpened,
  initialNavigation,
  layersOf,
  opened,
  pushed,
  replaced,
  selected,
  topOf,
  wentBack,
} from "./navigationState.ts";

describe("Settings → Hosts", () => {
  test("Hosts stays on the Settings tab, so the pill stays, and back returns to Settings", () => {
    const onHosts = hostsOpened(selected(initialNavigation, "settings"));

    expect(topOf(onHosts)).toEqual({ screen: "tabs" });
    expect(onHosts).toMatchObject({ tab: "settings", settings: "hosts" });
    expect(hostsClosed(onHosts)).toMatchObject({ tab: "settings", settings: "settings" });
  });

  test("Hosts from another tab's empty state switches to the Settings tab", () => {
    expect(hostsOpened(initialNavigation)).toMatchObject({ tab: "settings", settings: "hosts" });
  });

  test("Hosts is kept across tabs; tapping Settings again returns to Settings", () => {
    const onHosts = hostsOpened(initialNavigation);
    const away = selected(onHosts, "sessions");

    expect(selected(away, "settings").settings).toBe("hosts");
    expect(selected(onHosts, "settings").settings).toBe("settings");
  });

  test("a widget link from Hosts lands on Sessions", () => {
    const linked = opened(hostsOpened(initialNavigation), {
      screen: "thread",
      hostId: "h",
      sessionId: "s",
    });

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
