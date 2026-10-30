import { describe, expect, test } from "bun:test";
import { type CdpJson, type CdpMessage, SessionId } from "@polaris/protocol";
import { Schema } from "effect";
import {
  BrowserTab,
  BrowserTabEvent,
  BrowserTabId,
  BrowserTabOpener,
} from "../../shared/browserContract.ts";
import { tabRouting } from "../browser/routing.ts";
import { cdpFacade } from "./facade.ts";
import { routedTabs } from "./gate.ts";
import type { CdpDebuggee, CdpTabs, DetachListener, MessageListener } from "./ports.ts";

const mine = SessionId.make("mine");

/** A `webContents.debugger` that records what reached Chromium. */
class Debuggee implements CdpDebuggee {
  attached = false;
  readonly sent: Array<string> = [];

  attach(): void {
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  isAttached(): boolean {
    return this.attached;
  }

  sendCommand(method: string, params?: CdpJson): Promise<CdpJson> {
    this.sent.push(`${method} ${JSON.stringify(params ?? {})}`);

    return Promise.resolve({});
  }

  on(_event: "detach" | "message", _listener: DetachListener | MessageListener): this {
    return this;
  }

  off(_event: "detach" | "message", _listener: DetachListener | MessageListener): this {
    return this;
  }
}

const tabAt = (id: string, url: string, title: string | null = null) =>
  new BrowserTab({
    tabId: BrowserTabId.make(id),
    sessionId: mine,
    url,
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    hostAddress: true,
    agentDriving: false,
    openedBy: BrowserTabOpener.cases.User.make({}),
  });

/** One session's Browser behind the routing gate: tabs are unrouted until the test says. */
const world = () => {
  const tabs = new Map<string, BrowserTab>();
  const debuggees = new Map<string, Debuggee>();
  const listeners = new Set<(event: BrowserTabEvent) => void>();
  const routing = tabRouting();
  const closed: Array<string> = [];
  const state = { failFast: false };
  let next = 1;

  const publish = (event: BrowserTabEvent) => listeners.forEach((listener) => listener(event));

  const add = (url: string) => {
    const created = tabAt(`tab-${next++}`, url);

    tabs.set(created.tabId, created);
    debuggees.set(created.tabId, new Debuggee());
    publish(BrowserTabEvent.cases.Opened.make({ tab: created, byAgent: false }));

    return created;
  };

  const all: CdpTabs = {
    sessionTabs: () => [...tabs.values()],
    hasTabs: () => tabs.size > 0,
    debuggeeOf: (tabId) => debuggees.get(tabId) ?? null,
    openTab: async ({ url }) => {
      const created = add(url);

      // A setup that fails before the gate starts waiting (the Host already removed).
      if (state.failFast) routing.unrouted(created.tabId, new Error("rpi was removed"));

      return created;
    },
    closeTab: async ({ tabId }) => {
      closed.push(tabId);
    },
    activateTab: async () => undefined,
    allowsUrl: () => true,
    setAgentDriving: () => undefined,
    subscribe: (_host, _session, listener) => {
      listeners.add(listener);
      listener(
        BrowserTabEvent.cases.Snapshot.make({ tabs: [...tabs.values()], activeTabId: null })
      );

      return () => listeners.delete(listener);
    },
  };

  const sent: Array<CdpMessage> = [];

  const facade = cdpFacade({
    hostKey: "rpi",
    sessionId: mine,
    tabs: routedTabs(all, routing.view),
    send: (message) => sent.push(message),
    versions: { chrome: "140.0.0.0", v8: "14.0", userAgent: "Polaris Test" },
  });

  const call = async (id: number, method: string, params?: CdpJson, sessionId?: string) => {
    const base = params === undefined ? { id, method } : { id, method, params };

    facade.receive(sessionId === undefined ? base : { ...base, sessionId });

    for (let i = 0; i < 4; i++) await Bun.sleep(0);

    return sent.find((message) => message.id === id);
  };

  /** The relay's `Polaris.hello` with the tabs it remembers. */
  const hello = async (urls: ReadonlyArray<string>) => {
    facade.receive({ method: "Polaris.hello", params: { tabs: urls.map((url) => ({ url })) } });

    for (let i = 0; i < 4; i++) await Bun.sleep(0);
  };

  const debuggee = (tabId: string) => debuggees.get(tabId) ?? new Debuggee();

  return { tabs, add, publish, routing, call, hello, sent, debuggee, closed, state };
};

const Targets = Schema.Struct({
  targetInfos: Schema.Array(Schema.Struct({ targetId: Schema.String })),
});

const targetIds = (message: CdpMessage | undefined) =>
  Schema.decodeUnknownSync(Targets)(message?.result).targetInfos.map((info) => info.targetId);

const sessionOf = (message: CdpMessage | undefined) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(message?.result).sessionId;

const navigate = { url: "http://localhost:3000/" };

describe("CDP and a tab's routing", () => {
  test("a tab still setting up isn't a target: it can't be listed, attached or navigated", async () => {
    const { add, call, debuggee } = world();
    const pending = add("about:blank");

    const listed = await call(1, "Target.getTargets");

    const attach = await call(2, "Target.attachToTarget", {
      targetId: pending.tabId,
      flatten: true,
    });

    expect(targetIds(listed)).toEqual([]);
    expect(attach?.error?.message).toContain("No target");
    expect(debuggee(pending.tabId)).toMatchObject({ attached: false, sent: [] });
  });

  test("a tab whose setup failed stays out, and createTarget answers with the failure", async () => {
    const { add, call, routing, debuggee, tabs } = world();
    const failed = add("about:blank");

    routing.unrouted(failed.tabId, new Error("setProxy failed"));
    const created = call(1, "Target.createTarget", { url: "http://localhost:3000/" });

    await Bun.sleep(0);
    const opened = [...tabs.values()].at(-1)?.tabId ?? "";

    routing.unrouted(BrowserTabId.make(opened), new Error("setProxy failed"));

    const attach = await call(2, "Target.attachToTarget", {
      targetId: failed.tabId,
      flatten: true,
    });

    expect((await created)?.error).toBeTruthy();
    expect(attach?.error?.message).toContain("No target");
    expect([debuggee(failed.tabId).sent, debuggee(opened).sent]).toEqual([[], []]);
  });

  test("a setup that fails before createTarget waits still answers, and the agent's tab closes", async () => {
    const { call, state, closed, tabs } = world();

    state.failFast = true;
    const created = await call(1, "Target.createTarget", { url: "http://localhost:3000/" });

    expect(created?.error?.message).toContain("rpi was removed");
    expect(closed).toEqual([...tabs.keys()]);
  });

  test("a restored tab not routed yet isn't opened again when the relay says hello", async () => {
    const { add, hello, tabs } = world();

    add("http://localhost:3000/");
    await hello(["http://localhost:3000/"]);

    expect([...tabs.values()].map((tab) => tab.url)).toEqual(["http://localhost:3000/"]);
  });

  test("a setup that finishes after its Host was removed doesn't expose the tab", async () => {
    const { add, call, routing } = world();
    const tab = add("http://localhost:3000/");
    const begun = routing.begin(tab.tabId);

    routing.unrouted(tab.tabId, new Error("rpi was removed"));
    routing.routed(tab.tabId, begun);
    const attach = await call(1, "Target.attachToTarget", { targetId: tab.tabId, flatten: true });

    expect(attach?.error?.message).toContain("No target");
  });

  test("once routed a tab appears with its current fields, and navigating reaches Chromium", async () => {
    const { add, call, routing, tabs, debuggee, sent } = world();
    const tab = add("about:blank");

    await call(1, "Target.setDiscoverTargets", { discover: true });
    tabs.set(tab.tabId, tabAt(tab.tabId, "http://localhost:3000/", "App"));
    routing.routed(tab.tabId, routing.begin(tab.tabId));

    const session = sessionOf(
      await call(2, "Target.attachToTarget", { targetId: tab.tabId, flatten: true })
    );

    await call(3, "Page.navigate", navigate, session);

    expect(sent.find((m) => m.method === "Target.targetCreated")?.params).toMatchObject({
      targetInfo: { targetId: tab.tabId, url: "http://localhost:3000/", title: "App" },
    });
    expect(debuggee(tab.tabId).sent).toContain(`Page.navigate ${JSON.stringify(navigate)}`);
  });

  test("routing retired cuts the agent off: the session detaches and nothing more reaches the tab", async () => {
    const { add, call, routing, debuggee, sent } = world();
    const tab = add("http://localhost:3000/");

    routing.routed(tab.tabId, routing.begin(tab.tabId));

    const session = sessionOf(
      await call(1, "Target.attachToTarget", { targetId: tab.tabId, flatten: true })
    );

    routing.unrouted(tab.tabId, new Error("rpi was removed"));
    const after = await call(2, "Page.navigate", navigate, session);
    const again = await call(3, "Target.attachToTarget", { targetId: tab.tabId, flatten: true });

    expect(sent.some((m) => m.method === "Target.detachedFromTarget")).toBe(true);
    expect(after?.error).toBeTruthy();
    expect(again?.error?.message).toContain("No target");
    expect(debuggee(tab.tabId).attached).toBe(false);
    expect(debuggee(tab.tabId).sent.filter((line) => line.startsWith("Page."))).toEqual([]);
  });
});
