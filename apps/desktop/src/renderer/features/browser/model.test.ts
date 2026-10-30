import { describe, expect, test } from "bun:test";
import type { SessionId } from "@polaris/protocol";
import {
  BrowserTab,
  BrowserTabEvent,
  type BrowserTabId,
  BrowserTabOpener,
} from "../../../shared/browserContract.ts";
import { agentOpened, applyTabEvents, displayUrl, NO_TABS, tabLabel } from "./model.ts";

// SAFETY: test ids.
const id = (n: number) => `t${n}` as BrowserTabId;

const tab = (n: number, url = `http://localhost:${3000 + n}/`) =>
  new BrowserTab({
    tabId: id(n),
    // SAFETY: test id.
    sessionId: "s1" as SessionId,
    url,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    hostAddress: true,
    agentDriving: false,
    openedBy: BrowserTabOpener.cases.User.make({}),
  });

const CHANGE = {
  url: "http://localhost:3001/next",
  title: "Next",
  loading: true,
  canGoBack: true,
  canGoForward: false,
  hostAddress: true,
  agentDriving: true,
};

describe("applyTabEvents", () => {
  test("folds main's events into the tab list and the active tab", () => {
    const state = applyTabEvents(NO_TABS, [
      BrowserTabEvent.cases.Snapshot.make({ tabs: [tab(1)], activeTabId: id(1) }),
      BrowserTabEvent.cases.Opened.make({ tab: tab(2), byAgent: true }),
      BrowserTabEvent.cases.Changed.make({ tabId: id(1), ...CHANGE }),
      BrowserTabEvent.cases.Activated.make({ tabId: id(1) }),
      BrowserTabEvent.cases.Closed.make({ tabId: id(2) }),
    ]);

    expect(state.ready).toBe(true);
    expect(state.tabs.map((t) => t.tabId)).toEqual([id(1)]);
    expect(state.tabs[0]).toMatchObject({ title: "Next", agentDriving: true, canGoBack: true });
    expect(state.active).toBe(id(1));
  });

  test("closing the active tab leaves none active until main activates another", () => {
    const opened = applyTabEvents(NO_TABS, [
      BrowserTabEvent.cases.Snapshot.make({ tabs: [tab(1), tab(2)], activeTabId: id(2) }),
    ]);

    const closed = applyTabEvents(opened, [BrowserTabEvent.cases.Closed.make({ tabId: id(2) })]);

    expect(closed.active).toBeNull();
    expect(
      applyTabEvents(closed, [BrowserTabEvent.cases.Activated.make({ tabId: id(1) })]).active
    ).toBe(id(1));
  });

  test("an Activated for a tab it doesn't know leaves the active one", () => {
    const state = applyTabEvents(NO_TABS, [
      BrowserTabEvent.cases.Snapshot.make({ tabs: [tab(1)], activeTabId: id(1) }),
      BrowserTabEvent.cases.Activated.make({ tabId: id(9) }),
    ]);

    expect(state.active).toBe(id(1));
  });
});

describe("agentOpened", () => {
  test.each([
    [{ panelOpen: true, browserShown: true, heldClosed: false }, "stay"],
    [{ panelOpen: true, browserShown: false, heldClosed: false }, "dot"],
    [{ panelOpen: false, browserShown: false, heldClosed: false }, "show"],
    [{ panelOpen: false, browserShown: true, heldClosed: true }, "dot"],
  ] as const)("%o → %s", (place, outcome) => expect(agentOpened(place)).toBe(outcome));
});

describe("labels", () => {
  test("a tab without a title is labelled by its URL", () => {
    expect(tabLabel({ title: null, url: "http://localhost:3000/" })).toBe("localhost:3000");
    expect(tabLabel({ title: "  ", url: "https://example.com/a" })).toBe("example.com/a");
    expect(tabLabel({ title: "Sign in", url: "https://example.com/" })).toBe("Sign in");
  });

  test("the URL bar drops the scheme and a lone slash", () => {
    expect(displayUrl("http://localhost:5173/")).toBe("localhost:5173");
    expect(displayUrl("http://localhost:5173/sign-in")).toBe("localhost:5173/sign-in");
    expect(displayUrl("about:blank")).toBe("");
  });
});
