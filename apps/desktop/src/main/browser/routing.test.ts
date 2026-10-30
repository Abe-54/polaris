import { describe, expect, test } from "bun:test";
import type { BrowserTabId } from "../../shared/browserContract.ts";
import { tabRouting } from "./routing.ts";

// SAFETY: a test id; the brand only marks where it came from.
const TAB = "tab-1" as BrowserTabId;

describe("a tab's routing", () => {
  test("a setup that finishes after its Host's routing was retired doesn't route the tab", () => {
    const routing = tabRouting();
    const changes: Array<boolean> = [];

    routing.view.onChange((_tabId, routed) => changes.push(routed));
    const begun = routing.begin(TAB);

    routing.unrouted(TAB, new Error("rpi was removed"));

    expect(routing.routed(TAB, begun)).toBe(false);
    expect([routing.view.isRouted(TAB), changes]).toEqual([false, []]);
  });

  test("a failure is heard even after the fact, and a setup begun after it routes the tab again", async () => {
    const routing = tabRouting();

    routing.unrouted(TAB, new Error("rpi was removed"));

    const late = await routing.view.whenRouted(TAB).then(
      () => "routed",
      (error: Error) => error.message
    );

    const epoch = routing.begin(TAB);
    const waiting = routing.view.whenRouted(TAB);

    routing.routed(TAB, epoch);
    await waiting;

    expect(late).toBe("rpi was removed");

    expect(routing.view.isRouted(TAB)).toBe(true);
  });

  test("an older setup failing after a newer one began doesn't unroute the tab or fail its waiters", async () => {
    const routing = tabRouting();
    const older = routing.begin(TAB);
    const newer = routing.begin(TAB);

    const waiting = routing.view.whenRouted(TAB).then(
      () => "routed",
      (error: Error) => error.message
    );

    routing.failed(TAB, older, new Error("setProxy failed"));

    expect(routing.routed(TAB, newer)).toBe(true);
    expect(await waiting).toBe("routed");
  });
});
