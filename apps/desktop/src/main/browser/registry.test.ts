import { describe, expect, test } from "bun:test";
import { Predicate } from "effect";
import type { SessionId, WorkspaceId } from "@polaris/protocol";
import {
  type BrowserBounds,
  type BrowserTabEvent,
  type BrowserTabId,
  BrowserTabOpener,
} from "../../shared/browserContract.ts";
import { BrowserRefused, createRegistry, type ViewHost } from "./registry.ts";
import { type KeptSession, MAX_TABS } from "./tabs.ts";

// SAFETY: test ids; the brands only mark where they came from.
const sid = (id: string) => id as SessionId;

// SAFETY: test ids.
const wid = (id: string) => id as WorkspaceId;

const USER = BrowserTabOpener.cases.User.make({});

const AGENT = BrowserTabOpener.cases.Agent.make({});

const AT: BrowserBounds = { x: 10, y: 20, width: 400, height: 300 };

const fakeViews = () => {
  const live = new Set<string>();
  const log: Array<string> = [];
  let onScreen: string | null = null;

  const views: ViewHost = {
    create: (tab, place) => {
      live.add(tab.tabId);
      log.push(`create ${tab.url} in ${place.hostKey}/${place.workspaceId}`);
    },
    load: () => {},
    back: () => {},
    forward: () => {},
    reload: () => {},
    devtools: () => {},
    pick: (tabId) => {
      log.push(`pick ${tabId}`);

      return Promise.resolve(null);
    },
    cancelPick: () => {},
    show: (tabId, bounds) => {
      onScreen = bounds.width === 0 ? null : tabId;
    },
    hideAll: () => {
      onScreen = null;
    },
    destroy: (tabId) => {
      live.delete(tabId);
    },
  };

  return { views, live, log, onScreen: () => onScreen };
};

/** The sessions the fake Host knows, and their Workspaces. */
const ON_HOST = new Map([
  [sid("s1"), wid("w1")],
  [sid("s2"), wid("w1")],
  [sid("s-agent"), wid("w-agent")],
]);

const setup = (kept: ReadonlyArray<KeptSession> = []) => {
  const fake = fakeViews();
  const claims: Array<string> = [];
  let saved: ReadonlyArray<KeptSession> = kept;
  let next = 0;

  const registry = createRegistry({
    views: fake.views,
    hosting: {
      claim: (host, session) => claims.push(`claim ${host}/${session}`),
      release: (host, session) => claims.push(`release ${host}/${session}`),
    },
    kept,
    save: (sessions) => {
      saved = sessions;
    },
    // SAFETY: test ids.
    nextId: () => `tab-${++next}` as BrowserTabId,
    workspaceOf: async (host, session) => (host === "mac" ? (ON_HOST.get(session) ?? null) : null),
  });

  return { registry, fake, claims, saved: () => saved };
};

/** Whether `attempt` failed with a refusal. */
const refused = (attempt: Promise<unknown>) =>
  attempt.then(
    () => false,
    (cause: unknown) => cause instanceof BrowserRefused
  );

const open = (r: ReturnType<typeof setup>["registry"], url: string, sessionId = "s1") =>
  r.openTab({
    hostKey: "mac",
    sessionId: sid(sessionId),
    workspaceId: wid("w1"),
    url,
    openedBy: USER,
  });

describe("tab lists", () => {
  test("closing the active tab activates its right neighbour, else its left", async () => {
    const { registry } = setup();
    const a = await open(registry, "localhost:3000");
    const b = await open(registry, "localhost:3001");
    const c = await open(registry, "localhost:3002");

    registry.activateTab("mac", sid("s1"), b.tabId);
    registry.closeTab("mac", sid("s1"), b.tabId);
    expect(registry.sessionTabs("mac", sid("s1")).activeTabId).toBe(c.tabId);

    registry.closeTab("mac", sid("s1"), c.tabId);
    expect(registry.sessionTabs("mac", sid("s1")).activeTabId).toBe(a.tabId);

    registry.closeTab("mac", sid("s1"), a.tabId);
    expect(registry.sessionTabs("mac", sid("s1"))).toEqual({ tabs: [], activeTabId: null });
  });

  test("a tab of another session is refused, as is a URL no tab may load", async () => {
    const { registry } = setup();
    const mine = await open(registry, "localhost:3000", "s1");

    await open(registry, "localhost:4000", "s2");
    expect(() => registry.closeTab("mac", sid("s2"), mine.tabId)).toThrow(BrowserRefused);
    expect(() => registry.activateTab("laptop", sid("s1"), mine.tabId)).toThrow(BrowserRefused);
    // A pick reads the page and captures it: never in another session's tab.
    expect(() => registry.pick("mac", sid("s2"), mine.tabId)).toThrow(BrowserRefused);
    expect(registry.sessionTabs("mac", sid("s1")).tabs).toHaveLength(1);

    expect(await refused(open(registry, "file:///etc/passwd"))).toBe(true);
    expect(await refused(open(registry, "javascript:alert(1)"))).toBe(true);
  });

  test("a session stops opening tabs at the cap, so popups can't open views without end", async () => {
    const { registry, fake } = setup();

    for (let n = 0; n < MAX_TABS; n++) await open(registry, `localhost:${3000 + n}`);

    expect(await refused(open(registry, "localhost:9999"))).toBe(true);
    expect(fake.live.size).toBe(MAX_TABS);
  });

  test("a first tab gets the partition its Host names, whatever Workspace the renderer says", async () => {
    const { registry, fake } = setup();

    const elsewhere = registry.openTab({
      hostKey: "mac",
      sessionId: sid("s1"),
      workspaceId: wid("w2"),
      url: "localhost:3000",
      openedBy: USER,
    });

    expect(await refused(elsewhere)).toBe(true);

    const ghost = registry.openTab({
      hostKey: "mac",
      sessionId: sid("ghost"),
      workspaceId: wid("w1"),
      url: "localhost:3000",
      openedBy: USER,
    });

    expect(await refused(ghost)).toBe(true);
    expect(fake.log).toEqual([]);
    expect(registry.sessionTabs("mac", sid("s1")).tabs).toEqual([]);
  });

  test("a session's Browser stays in its first workspace", async () => {
    const { registry } = setup();

    await open(registry, "localhost:3000");

    const moved = registry.openTab({
      hostKey: "mac",
      sessionId: sid("s1"),
      workspaceId: wid("elsewhere"),
      url: "localhost:3000",
      openedBy: USER,
    });

    expect(await refused(moved)).toBe(true);
  });

  test("an agent's tab finds its session's workspace on the Host and loads at once", async () => {
    const { registry, fake } = setup();
    const events: Array<BrowserTabEvent> = [];

    registry.subscribe("mac", sid("s-agent"), (e) => events.push(e));

    const tab = await registry.openTab({
      hostKey: "mac",
      sessionId: sid("s-agent"),
      url: "localhost:5173",
      openedBy: AGENT,
    });

    expect(fake.log).toEqual(["create http://localhost:5173/ in mac/w-agent"]);
    expect(events.map((e) => e._tag)).toEqual(["Snapshot", "Opened"]);
    expect(events[1]).toMatchObject({
      byAgent: true,
      tab: { tabId: tab.tabId, hostAddress: true },
    });

    const ghost = registry.openTab({
      hostKey: "mac",
      sessionId: sid("ghost"),
      url: "a.com",
      openedBy: AGENT,
    });

    expect(await refused(ghost)).toBe(true);
  });
});

describe("showing and claiming", () => {
  test("showing claims once, resizes don't reclaim, switching sessions releases the last", async () => {
    const { registry, claims, fake } = setup();
    const tab = await open(registry, "localhost:3000", "s1");

    await open(registry, "localhost:4000", "s2");
    registry.show("mac", sid("s1"), AT);
    registry.show("mac", sid("s1"), { ...AT, width: 500 });
    expect(fake.onScreen()).toBe(tab.tabId);

    registry.show("mac", sid("s1"), { ...AT, width: 0 });
    expect(fake.onScreen()).toBeNull();

    registry.show("mac", sid("s2"), AT);
    registry.hide("mac", sid("s2"));
    registry.hide("mac", sid("s2"));
    expect(claims).toEqual(["claim mac/s1", "release mac/s1", "claim mac/s2", "release mac/s2"]);
    expect(fake.onScreen()).toBeNull();
  });
});

describe("an agent driving a tab", () => {
  const drivingOf = (r: ReturnType<typeof setup>["registry"], tabId: BrowserTabId) =>
    r.sessionTabs("mac", sid("s1")).tabs.find((t) => t.tabId === tabId)?.agentDriving;

  test("a commanded tab is driven only while its session's Turn runs; the Turn's end frees it", async () => {
    const { registry } = setup();
    const tab = await open(registry, "localhost:3000", "s1");
    const other = await open(registry, "localhost:4000", "s2");
    const events: Array<BrowserTabEvent> = [];

    registry.subscribe("mac", sid("s1"), (e) => events.push(e));

    // Between Turns an agent-browser still attached sends nothing that drives the tab.
    registry.setAgentDriving(tab.tabId, true);
    expect(drivingOf(registry, tab.tabId)).toBe(false);

    registry.setWorking([
      { hostKey: "mac", sessionId: sid("s1") },
      { hostKey: "mac", sessionId: sid("s2") },
    ]);
    registry.setAgentDriving(tab.tabId, true);
    registry.setAgentDriving(other.tabId, true);
    expect(drivingOf(registry, tab.tabId)).toBe(true);

    // s1's Turn ends; s2's goes on.
    registry.setWorking([{ hostKey: "mac", sessionId: sid("s2") }]);
    expect(drivingOf(registry, tab.tabId)).toBe(false);
    expect(
      registry.sessionTabs("mac", sid("s2")).tabs.find((t) => t.tabId === other.tabId)?.agentDriving
    ).toBe(true);
    expect(
      events.flatMap((e) => (Predicate.isTagged(e, "Changed") ? [e.agentDriving] : []))
    ).toEqual([true, false]);
  });
});

describe("kept across restarts", () => {
  test("tabs come back in order with the active one, under fresh ids, loading only when shown", async () => {
    const first = setup();

    await open(first.registry, "localhost:3000");
    const b = await open(first.registry, "example.com");

    await open(first.registry, "localhost:3002");
    first.registry.activateTab("mac", sid("s1"), b.tabId);

    const second = setup(first.saved());
    const { tabs, activeTabId } = second.registry.sessionTabs("mac", sid("s1"));

    expect(tabs.map((t) => t.url)).toEqual([
      "http://localhost:3000/",
      "https://example.com/",
      "http://localhost:3002/",
    ]);
    expect(activeTabId).toBe(tabs[1]?.tabId ?? null);
    expect(second.fake.live.size).toBe(0);

    second.registry.show("mac", sid("s1"), AT);
    expect(second.fake.log).toEqual(["create https://example.com/ in mac/w1"]);
  });

  test("an archived session's tabs close and are not kept", async () => {
    const { registry, fake, saved, claims } = setup();

    await open(registry, "localhost:3000", "s1");
    await open(registry, "localhost:4000", "s2");
    registry.show("mac", sid("s1"), AT);
    registry.forget("mac", [sid("s1")]);

    expect(registry.sessionTabs("mac", sid("s1")).tabs).toEqual([]);
    expect(saved().map((s) => s.sessionId)).toEqual([sid("s2")]);
    expect(fake.live.size).toBe(1);
    expect(fake.onScreen()).toBeNull();
    expect(claims.at(-1)).toBe("release mac/s1");
  });

  test("a session kept with more tabs than the cap comes back with the cap", () => {
    const many = Array.from({ length: MAX_TABS + 6 }, (_, n) => ({
      url: `http://localhost:${3000 + n}/`,
      title: null,
      openedBy: USER,
    }));

    const { registry } = setup([
      { hostKey: "mac", sessionId: sid("s1"), workspaceId: wid("w1"), tabs: many, active: 0 },
    ]);

    expect(registry.sessionTabs("mac", sid("s1")).tabs).toHaveLength(MAX_TABS);
  });

  test("forgetting reaches sessions only kept on disk", async () => {
    const first = setup();

    await open(first.registry, "localhost:3000", "s1");

    const second = setup(first.saved());

    second.registry.forget("mac", [sid("s1")]);
    expect(second.saved()).toEqual([]);
  });
});
