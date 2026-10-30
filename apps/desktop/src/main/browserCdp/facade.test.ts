import { expect, test } from "bun:test";
import { type CdpJson, type CdpMessage, SessionId } from "@polaris/protocol";
import { Predicate, Schema } from "effect";
import {
  BrowserTab,
  BrowserTabEvent,
  BrowserTabId,
  BrowserTabOpener,
} from "../../shared/browserContract.ts";
import { cdpFacade, MAX_COMMANDS_IN_FLIGHT } from "./facade.ts";
import type {
  CdpDebuggee,
  CdpTabs,
  DetachListener,
  MessageListener,
  OpenTabInput,
} from "./ports.ts";

const host = "local";

const mine = SessionId.make("mine");

const theirs = SessionId.make("theirs");

interface SentCommand {
  readonly method: string;
  readonly params: CdpJson | undefined;
  readonly sessionId: string | undefined;
}

/** A fake `webContents.debugger`: records commands, lets the test emit events and detach. */
class FakeDebuggee implements CdpDebuggee {
  attached = false;
  attaches = 0;
  readonly commands: Array<SentCommand> = [];
  private readonly detachListeners = new Set<DetachListener>();
  private readonly messageListeners = new Set<MessageListener>();
  failAttach = false;

  attach(): void {
    if (this.failAttach) throw new Error("Debugger is already attached");
    this.attached = true;
    this.attaches += 1;
  }

  detach(): void {
    this.attached = false;
  }

  isAttached(): boolean {
    return this.attached;
  }

  sendCommand(method: string, params?: CdpJson, sessionId?: string): Promise<CdpJson> {
    this.commands.push({ method, params, sessionId });

    if (method === "Runtime.evaluate" && params !== undefined && "hang" in Object(params))
      return new Promise(() => undefined);

    if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: 42 } });

    if (method === "Fetch.takeResponseBodyAsStream") return Promise.resolve({ stream: "h1" });

    if (method === "Page.navigate")
      return Promise.reject(new Error("Cannot navigate to invalid URL"));

    return Promise.resolve({});
  }

  on(event: "detach", listener: DetachListener): this;
  on(event: "message", listener: MessageListener): this;
  on(event: "detach" | "message", listener: DetachListener | MessageListener): this {
    if (event === "message") {
      this.messageListeners.add(listener);

      return this;
    }

    // SAFETY: the "detach" overload only takes a DetachListener.
    this.detachListeners.add(listener as DetachListener);

    return this;
  }

  off(event: "detach", listener: DetachListener): this;
  off(event: "message", listener: MessageListener): this;
  off(event: "detach" | "message", listener: DetachListener | MessageListener): this {
    if (event === "message") {
      this.messageListeners.delete(listener);

      return this;
    }

    // SAFETY: the "detach" overload only takes a DetachListener.
    this.detachListeners.delete(listener as DetachListener);

    return this;
  }

  emit(method: string, params: CdpJson, sessionId = ""): void {
    for (const listener of this.messageListeners)
      listener(new Event("message"), method, params, sessionId);
  }

  /** DevTools opened: Electron detaches the debugger. */
  devtoolsDetach(): void {
    this.attached = false;

    for (const listener of this.detachListeners) listener(new Event("detach"), "target closed");
  }
}

const tab = (
  sessionId: SessionId,
  id: string,
  url: string,
  title: string | null,
  openedBy: BrowserTabOpener
) =>
  new BrowserTab({
    tabId: BrowserTabId.make(id),
    sessionId,
    url,
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    hostAddress: false,
    agentDriving: false,
    openedBy,
  });

const byUser = BrowserTabOpener.cases.User.make({});

/** Two sessions' tabs in one Desktop App. */
const fakeTabs = () => {
  const tabs = new Map<string, BrowserTab>();
  const debuggees = new Map<string, FakeDebuggee>();
  const listeners = new Map<SessionId, Set<(event: BrowserTabEvent) => void>>();
  const driving = new Map<string, boolean>();
  const opened: Array<OpenTabInput> = [];
  const closed: Array<string> = [];
  const gates: Array<() => void> = [];
  let holdOpens = false;
  let next = 1;

  const add = (
    sessionId: SessionId,
    url: string,
    title: string | null = null,
    openedBy: BrowserTabOpener = byUser
  ) => {
    const created = tab(sessionId, `tab-${next++}`, url, title, openedBy);
    tabs.set(created.tabId, created);
    debuggees.set(created.tabId, new FakeDebuggee());

    return created;
  };

  const debuggee = (tabId: string): FakeDebuggee => {
    const found = debuggees.get(tabId);

    if (found === undefined) throw new Error(`no debuggee for ${tabId}`);

    return found;
  };

  const publish = (sessionId: SessionId, event: BrowserTabEvent) => {
    for (const listener of listeners.get(sessionId) ?? []) listener(event);
  };

  const port: CdpTabs = {
    sessionTabs: (_host, sessionId) =>
      Array.from(tabs.values()).filter((t) => t.sessionId === sessionId),
    hasTabs: (_host, sessionId) => Array.from(tabs.values()).some((t) => t.sessionId === sessionId),
    debuggeeOf: (tabId) => debuggees.get(tabId) ?? null,
    openTab: async (input) => {
      opened.push(input);

      if (holdOpens) await new Promise<void>((resolve) => gates.push(resolve));

      if (input.url.startsWith("file:")) throw new Error("BrowserRefused: file URLs do not open");
      const created = add(input.sessionId, input.url, null, input.openedBy);
      publish(
        input.sessionId,
        BrowserTabEvent.cases.Opened.make({
          tab: created,
          byAgent: !Predicate.isTagged("User")(input.openedBy),
        })
      );

      return created;
    },
    closeTab: async ({ sessionId, tabId }) => {
      closed.push(tabId);
      tabs.delete(tabId);
      debuggees.delete(tabId);
      publish(sessionId, BrowserTabEvent.cases.Closed.make({ tabId }));
    },
    activateTab: async () => undefined,
    allowsUrl: (url) => !url.startsWith("file:"),
    setAgentDriving: (tabId, value) => void driving.set(tabId, value),
    subscribe: (_host, sessionId, listener) => {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);

      return () => void set.delete(listener);
    },
  };

  const holdOpening = () => {
    holdOpens = true;

    return () => gates.splice(0).forEach((release) => release());
  };

  return { port, add, debuggee, publish, driving, opened, closed, tabs, holdOpening };
};

const SessionResult = Schema.Struct({ sessionId: Schema.String });

const TargetResult = Schema.Struct({ targetId: Schema.String });

const sessionOf = (message: CdpMessage) =>
  Schema.decodeUnknownSync(SessionResult)(message.result).sessionId;

const targetOf = (message: CdpMessage) =>
  Schema.decodeUnknownSync(TargetResult)(message.result).targetId;

const facadeOn = (world: ReturnType<typeof fakeTabs>, sessionId = mine) => {
  const sent: Array<CdpMessage> = [];
  const overflows: Array<string> = [];

  const facade = cdpFacade({
    hostKey: host,
    sessionId,
    tabs: world.port,
    send: (message) => sent.push(message),
    versions: { chrome: "140.0.0.0", v8: "14.0", userAgent: "Polaris Test" },
    overflow: (reason) => overflows.push(reason),
  });

  const call = async (
    id: number,
    method: string,
    params?: CdpJson,
    session?: string
  ): Promise<CdpMessage> => {
    const base = { id, method };
    const withParams = params === undefined ? base : { ...base, params };
    facade.receive(session === undefined ? withParams : { ...withParams, sessionId: session });
    await Bun.sleep(0);
    await Bun.sleep(0);
    const reply = sent.find((message) => message.id === id);

    if (reply === undefined) throw new Error(`no reply to ${method} (${id})`);

    return reply;
  };

  const events = (method: string) => sent.filter((message) => message.method === method);

  return { facade, sent, call, events, overflows };
};

test("the agent sees and attaches to this session's tabs only; another session's tab is no target", async () => {
  const world = fakeTabs();
  const a = world.add(mine, "http://localhost:3000/", "App");
  world.add(theirs, "http://localhost:4000/", "Other");
  const b = world.add(mine, "http://localhost:3000/about");
  const { call } = facadeOn(world);

  const version = await call(1, "Browser.getVersion");
  expect(version.result).toEqual({
    protocolVersion: "1.3",
    product: "Chrome/140.0.0.0",
    revision: "",
    userAgent: "Polaris Test",
    jsVersion: "14.0",
  });

  const listed = await call(2, "Target.getTargets");
  expect(listed.result).toEqual({
    targetInfos: [
      {
        targetId: a.tabId,
        type: "page",
        title: "App",
        url: "http://localhost:3000/",
        attached: false,
        canAccessOpener: false,
        browserContextId: "polaris:mine",
      },
      {
        targetId: b.tabId,
        type: "page",
        title: "http://localhost:3000/about",
        url: "http://localhost:3000/about",
        attached: false,
        canAccessOpener: false,
        browserContextId: "polaris:mine",
      },
    ],
  });

  const notFound = { code: -32000, message: "No target with given id found" };
  const foreign = await call(3, "Target.attachToTarget", { targetId: "tab-2", flatten: true });
  expect(foreign.error).toEqual(notFound);
  const info = await call(4, "Target.getTargetInfo", { targetId: "tab-2" });
  expect(info.error).toEqual(notFound);
  const closeForeign = await call(5, "Target.closeTarget", { targetId: "tab-2" });
  expect(closeForeign.error).toEqual(notFound);
  expect(world.tabs.has("tab-2")).toBe(true);
});

test("browser-wide methods are refused, with and without a session", async () => {
  const world = fakeTabs();
  const a = world.add(mine, "http://localhost:3000/");
  const { call } = facadeOn(world);

  const session = sessionOf(
    await call(1, "Target.attachToTarget", { targetId: a.tabId, flatten: true })
  );

  const refused: Array<[string, CdpJson]> = [
    ["Target.createBrowserContext", {}],
    ["Browser.close", {}],
    ["SystemInfo.getInfo", {}],
    ["Browser.grantPermissions", { permissions: ["geolocation"] }],
    ["Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/anywhere" }],
    ["Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/tmp" }],
    ["Target.getBrowserContexts", {}],
    ["Browser.setContentsSize", { windowId: 1, width: 800, height: 600 }],
    ["Target.attachToBrowserTarget", {}],
    ["DOM.setFileInputFiles", { files: ["/etc/passwd"], nodeId: 1 }],
    ["Page.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp" }],
    ["Page.setInterceptFileChooserDialog", { enabled: true }],
    ["Network.loadNetworkResource", { url: "file:///etc/hosts", options: {} }],
    ["Input.dispatchDragEvent", { type: "drop", x: 1, y: 1, data: { files: ["/etc/hosts"] } }],
    ["Security.setIgnoreCertificateErrors", { ignore: true }],
    ["Security.setOverrideCertificateErrors", { override: true }],
    ["Security.handleCertificateError", { eventId: 1, action: "continue" }],
    ["Storage.getCookies", {}],
    ["Storage.clearDataForOrigin", { origin: "*", storageTypes: "all" }],
    ["ServiceWorker.enable", {}],
    ["Tracing.start", {}],
  ];

  let id = 10;

  for (const [method, params] of refused) {
    const plain = await call(id++, method, params);
    expect(plain.error).toMatchObject({ code: -32000 });
    expect(plain.error?.message).toContain(
      method.endsWith("setDownloadBehavior") ? "deny" : method
    );
    const onSession = await call(id++, method, params, session);
    expect(onSession.error).toMatchObject({ code: -32000 });
  }

  expect(world.debuggee(a.tabId).commands.map((c) => c.method)).toEqual([
    "Emulation.setFocusEmulationEnabled",
  ]);

  const deny = await call(id++, "Browser.setDownloadBehavior", { behavior: "deny" });
  expect(deny.result).toEqual({});

  const drag = await call(
    id++,
    "Input.dispatchDragEvent",
    { type: "dragEnter", x: 1, y: 1, data: { items: [], dragOperationsMask: 1 } },
    session
  );

  expect(drag.result).toEqual({});
  // Browser-level page methods: nowhere to go without a session.
  const stray = await call(id++, "Network.getCookies", {});
  expect(stray.error).toMatchObject({ code: -32601 });
});

test("page commands and events travel under the facade's session ids, nested sessions included", async () => {
  const world = fakeTabs();
  const a = world.add(mine, "http://localhost:3000/");
  const debuggee = world.debuggee(a.tabId);
  const { call, sent, events } = facadeOn(world);

  const session = sessionOf(
    await call(1, "Target.attachToTarget", { targetId: a.tabId, flatten: true })
  );

  expect(session).toMatch(/^[0-9A-F]{32}$/);
  expect(debuggee.attached).toBe(true);
  expect(events("Target.attachedToTarget")).toMatchObject([
    {
      params: {
        sessionId: session,
        targetInfo: { targetId: a.tabId, attached: true },
        waitingForDebugger: false,
      },
    },
  ]);
  const again = await call(2, "Target.attachToTarget", { targetId: a.tabId, flatten: true });
  expect(again.result).toEqual({ sessionId: session });

  const evaluated = await call(3, "Runtime.evaluate", { expression: "6 * 7" }, session);
  expect(evaluated).toEqual({ id: 3, sessionId: session, result: { result: { value: 42 } } });
  // Focus emulation first, or a background tab ignores the agent's clicks.
  expect(debuggee.commands).toEqual([
    {
      method: "Emulation.setFocusEmulationEnabled",
      params: { enabled: true },
      sessionId: undefined,
    },
    { method: "Runtime.evaluate", params: { expression: "6 * 7" }, sessionId: undefined },
  ]);

  const failed = await call(4, "Page.navigate", { url: "nope" }, session);
  expect(failed.error).toEqual({ code: -32000, message: "Cannot navigate to invalid URL" });

  const unknown = await call(5, "Runtime.evaluate", {}, "DEADBEEF");
  expect(unknown.error).toEqual({ code: -32001, message: "Session with given id not found." });

  debuggee.emit("Page.loadEventFired", { timestamp: 1 });
  expect(sent.at(-1)).toEqual({
    method: "Page.loadEventFired",
    params: { timestamp: 1 },
    sessionId: session,
  });

  // An iframe's session Chromium opened under the tab routes back through the tab's debugger.
  debuggee.emit("Target.attachedToTarget", { sessionId: "CHILD1", targetInfo: { type: "iframe" } });
  debuggee.emit("Runtime.consoleAPICalled", { type: "log" }, "CHILD1");
  expect(sent.at(-1)).toEqual({
    method: "Runtime.consoleAPICalled",
    params: { type: "log" },
    sessionId: "CHILD1",
  });
  const inChild = await call(6, "Runtime.evaluate", { expression: "1" }, "CHILD1");
  expect(inChild.result).toEqual({ result: { value: 42 } });
  expect(debuggee.commands.at(-1)).toEqual({
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId: "CHILD1",
  });
  debuggee.emit("Target.detachedFromTarget", { sessionId: "CHILD1" });
  const afterChild = await call(7, "Runtime.evaluate", { expression: "1" }, "CHILD1");
  expect(afterChild.error).toMatchObject({ code: -32001 });

  // Navigation follows the Browser's policy here too, and a browser target under the tab never routes.
  const blocked = await call(9, "Page.navigate", { url: "file:///etc/passwd" }, session);
  expect(blocked.error).toEqual({ code: -32000, message: "A tab can't open file:///etc/passwd" });
  expect(debuggee.commands.filter((c) => c.method === "Page.navigate")).toEqual([
    { method: "Page.navigate", params: { url: "nope" }, sessionId: undefined },
  ]);
  debuggee.emit("Target.attachedToTarget", {
    sessionId: "BROWSER1",
    targetInfo: { type: "browser" },
  });
  const viaBrowser = await call(10, "Runtime.evaluate", { expression: "1" }, "BROWSER1");
  expect(viaBrowser.error).toMatchObject({ code: -32001 });

  const detached = await call(8, "Target.detachFromTarget", { sessionId: session });
  expect(detached.result).toEqual({});
  expect(debuggee.attached).toBe(false);
  expect(world.driving.get(a.tabId)).toBe(false);
});

test("a tab the agent only attached to and set up isn't driven; a command that acts on it is", async () => {
  const world = fakeTabs();
  const { call } = facadeOn(world);

  await call(1, "Target.setAutoAttach", { autoAttach: true, flatten: true });

  // The person's own new tab: agent-browser auto-attaches and sets it up like any other.
  const userTab = world.add(mine, "http://localhost:3000/user");

  world.publish(mine, BrowserTabEvent.cases.Opened.make({ tab: userTab, byAgent: false }));

  const session = sessionOf(
    await call(2, "Target.attachToTarget", { targetId: userTab.tabId, flatten: true })
  );

  const setup = [
    "Page.enable",
    "Runtime.enable",
    "Network.enable",
    "Page.getFrameTree",
    "Page.setLifecycleEventsEnabled",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.addBinding",
    "Emulation.setFocusEmulationEnabled",
    "Runtime.runIfWaitingForDebugger",
    "Target.setAutoAttach",
  ];

  let id = 3;

  for (const method of setup) await call(id++, method, {}, session);
  expect(world.driving.get(userTab.tabId)).toBeUndefined();

  await call(id++, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 }, session);
  expect(world.driving.get(userTab.tabId)).toBe(true);
});

test("Target.createTarget opens a tab in this session's Browser as the agent, driven at once under auto-attach", async () => {
  const world = fakeTabs();
  const { call, events } = facadeOn(world);
  await call(1, "Target.setDiscoverTargets", { discover: true });
  await call(2, "Target.setAutoAttach", {
    autoAttach: true,
    flatten: true,
    waitForDebuggerOnStart: false,
  });

  const targetId = targetOf(
    await call(3, "Target.createTarget", { url: "http://localhost:3000/new" })
  );

  expect(world.opened).toEqual([
    {
      hostKey: host,
      sessionId: mine,
      url: "http://localhost:3000/new",
      openedBy: BrowserTabOpener.cases.Agent.make({}),
    },
  ]);
  expect(world.tabs.get(targetId)?.sessionId).toBe(mine);
  expect(events("Target.targetCreated")).toMatchObject([{ params: { targetInfo: { targetId } } }]);
  expect(events("Target.attachedToTarget")).toHaveLength(1);
  expect(world.driving.get(targetId)).toBe(true);

  // A tab the user opens later is announced and auto-attached too; a closed one is destroyed.
  const userTab = world.add(mine, "http://localhost:3000/user");
  world.publish(mine, BrowserTabEvent.cases.Opened.make({ tab: userTab, byAgent: false }));
  expect(events("Target.attachedToTarget")).toHaveLength(2);
  world.publish(
    theirs,
    BrowserTabEvent.cases.Opened.make({
      tab: world.add(theirs, "http://localhost:4000/"),
      byAgent: false,
    })
  );
  expect(events("Target.targetCreated")).toHaveLength(2);

  const closed = await call(4, "Target.closeTarget", { targetId });
  expect(closed.result).toEqual({ success: true });
  expect(world.closed).toEqual([targetId]);
  expect(events("Target.detachedFromTarget")).toHaveLength(1);
  expect(events("Target.targetDestroyed")).toMatchObject([{ params: { targetId } }]);

  const refusedUrl = await call(5, "Target.createTarget", { url: "file:///etc/passwd" });
  expect(refusedUrl.error).toMatchObject({
    code: -32000,
    message: "BrowserRefused: file URLs do not open",
  });
});

test("closing the facade detaches every tab and clears the indicator; a hub shared with another facade stays attached", async () => {
  const world = fakeTabs();
  const a = world.add(mine, "http://localhost:3000/");
  const debuggee = world.debuggee(a.tabId);
  const first = facadeOn(world);
  const second = facadeOn(world);

  await first.call(1, "Target.attachToTarget", { targetId: a.tabId, flatten: true });

  const shared = sessionOf(
    await second.call(1, "Target.attachToTarget", { targetId: a.tabId, flatten: true })
  );

  expect(debuggee.attaches).toBe(1);
  await second.call(2, "Runtime.evaluate", { expression: "1" }, shared);

  first.facade.close();
  expect(debuggee.attached).toBe(true);
  expect(world.driving.get(a.tabId)).toBe(true);
  debuggee.emit("Page.loadEventFired", {});
  expect(first.events("Page.loadEventFired")).toHaveLength(0);
  expect(second.events("Page.loadEventFired")).toHaveLength(1);

  second.facade.close();
  expect(debuggee.attached).toBe(false);
  expect(world.driving.get(a.tabId)).toBe(false);
  expect(first.events("Target.detachedFromTarget")).toHaveLength(0);
});

test("DevTools detaching the debugger is survived by reattaching; a failed reattach ends the session", async () => {
  const world = fakeTabs();
  const a = world.add(mine, "http://localhost:3000/");
  const debuggee = world.debuggee(a.tabId);
  const { call, events } = facadeOn(world);

  const session = sessionOf(
    await call(1, "Target.attachToTarget", { targetId: a.tabId, flatten: true })
  );

  debuggee.devtoolsDetach();
  expect(debuggee.attached).toBe(true);
  expect(debuggee.attaches).toBe(2);
  expect(
    debuggee.commands.filter((c) => c.method === "Emulation.setFocusEmulationEnabled")
  ).toHaveLength(2);
  const still = await call(2, "Runtime.evaluate", { expression: "1" }, session);
  expect(still.result).toEqual({ result: { value: 42 } });

  debuggee.failAttach = true;
  debuggee.devtoolsDetach();
  expect(events("Target.detachedFromTarget")).toMatchObject([
    { params: { sessionId: session, targetId: a.tabId } },
  ]);
  expect(world.driving.get(a.tabId)).toBe(false);
  const gone = await call(3, "Runtime.evaluate", { expression: "1" }, session);
  expect(gone.error).toMatchObject({ code: -32001 });
});

test("the relay's hello reopens remembered tabs only into an empty Browser, and tab reports follow every change", async () => {
  const empty = fakeTabs();
  const { facade, sent } = facadeOn(empty);
  facade.receive({
    method: "Polaris.hello",
    params: {
      tabs: [
        { url: "http://localhost:3000/a" },
        { url: "file:///x" },
        { url: "http://localhost:3000/b" },
      ],
    },
  });
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(empty.opened.map((o) => [o.url, o.openedBy])).toEqual([
    ["http://localhost:3000/a", byUser],
    ["file:///x", byUser],
    ["http://localhost:3000/b", byUser],
  ]);
  expect(sent.at(-1)).toEqual({
    method: "Polaris.tabs",
    params: {
      tabs: [
        { targetId: "tab-1", url: "http://localhost:3000/a", title: "" },
        { targetId: "tab-2", url: "http://localhost:3000/b", title: "" },
      ],
    },
  });

  const populated = fakeTabs();
  populated.add(mine, "http://localhost:5000/", "Already");
  const other = facadeOn(populated);
  other.facade.receive({
    method: "Polaris.hello",
    params: { tabs: [{ url: "http://localhost:3000/a" }] },
  });
  await Bun.sleep(0);
  expect(populated.opened).toEqual([]);
  expect(other.sent.at(-1)).toEqual({
    method: "Polaris.tabs",
    params: { tabs: [{ targetId: "tab-1", url: "http://localhost:5000/", title: "Already" }] },
  });

  populated.publish(
    mine,
    BrowserTabEvent.cases.Changed.make({
      tabId: BrowserTabId.make("tab-1"),
      url: "http://localhost:5000/next",
      title: "Next",
      loading: false,
      canGoBack: true,
      canGoForward: false,
      hostAddress: true,
      agentDriving: false,
    })
  );
  expect(other.sent.at(-1)).toEqual({
    method: "Polaris.tabs",
    params: { tabs: [{ targetId: "tab-1", url: "http://localhost:5000/next", title: "Next" }] },
  });

  other.facade.receive({ method: "Target.getTargets" });
  expect(other.sent.at(-1)).toEqual({
    id: null,
    error: { code: -32600, message: "Message must have integer 'id' property" },
  });
});

test("a tab session sends only its own domains: unlisted ones are refused, and IO reads only streams the tab handed out", async () => {
  const world = fakeTabs();
  const a = world.add(mine, "http://localhost:3000/");
  const debuggee = world.debuggee(a.tabId);
  const { call } = facadeOn(world);

  const session = sessionOf(
    await call(1, "Target.attachToTarget", { targetId: a.tabId, flatten: true })
  );

  const unlisted = [
    "WebAuthn.enable",
    "IndexedDB.requestDatabaseNames",
    "CacheStorage.requestCacheNames",
    "Browser.getVersion",
    "Target.getTargets",
    "WebMCP.enable",
  ];

  let id = 2;

  for (const method of unlisted) {
    const refused = await call(id++, method, {}, session);
    expect(refused.error).toEqual({
      code: -32000,
      message: `${method} is not available through this Browser: only a tab's own domains are.`,
    });
  }

  const foreign = await call(id++, "IO.read", { handle: "stolen" }, session);
  expect(foreign.error).toEqual({
    code: -32000,
    message: "IO.read may only read a stream this tab handed out.",
  });

  const issued = await call(id++, "Fetch.takeResponseBodyAsStream", { requestId: "r1" }, session);
  expect(issued.result).toEqual({ stream: "h1" });
  const read = await call(id++, "IO.read", { handle: "h1" }, session);
  expect(read.result).toEqual({});
  await call(id++, "IO.close", { handle: "h1" }, session);
  const afterClose = await call(id++, "IO.read", { handle: "h1" }, session);
  expect(afterClose.error).toMatchObject({ code: -32000 });

  // Page-level auto-attach for the tab's frames is the one Target method a session keeps.
  const auto = await call(
    id++,
    "Target.setAutoAttach",
    { autoAttach: true, flatten: true },
    session
  );

  expect(auto.result).toEqual({});
  expect(debuggee.commands.map((c) => c.method)).toEqual([
    "Emulation.setFocusEmulationEnabled",
    "Fetch.takeResponseBodyAsStream",
    "IO.read",
    "IO.close",
    "Target.setAutoAttach",
  ]);
});

test("too many commands awaiting answers close the facade and tell the stream", async () => {
  const world = fakeTabs();
  const a = world.add(mine, "http://localhost:3000/");
  const debuggee = world.debuggee(a.tabId);
  const { facade, sent, overflows, call } = facadeOn(world);

  const session = sessionOf(
    await call(1, "Target.attachToTarget", { targetId: a.tabId, flatten: true })
  );

  for (let id = 2; id <= MAX_COMMANDS_IN_FLIGHT + 1; id++)
    facade.receive({ id, method: "Runtime.evaluate", params: { hang: true }, sessionId: session });
  expect(overflows).toEqual([]);
  facade.receive({
    id: MAX_COMMANDS_IN_FLIGHT + 2,
    method: "Runtime.evaluate",
    params: { hang: true },
    sessionId: session,
  });
  expect(overflows).toEqual([`${MAX_COMMANDS_IN_FLIGHT} commands awaiting answers`]);
  expect(debuggee.attached).toBe(false);
  expect(world.driving.get(a.tabId)).toBe(false);
  facade.receive({ id: 999, method: "Browser.getVersion" });
  expect(sent.some((m) => m.id === 999)).toBe(false);
});

test("a tab that finishes opening after the facade closed is never attached, and goes", async () => {
  const world = fakeTabs();
  const release = world.holdOpening();
  const { facade, sent } = facadeOn(world);
  facade.receive({
    id: 1,
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  facade.receive({
    id: 2,
    method: "Target.createTarget",
    params: { url: "http://localhost:3000/late" },
  });
  await Bun.sleep(0);
  expect(world.opened).toHaveLength(1);

  facade.close();
  release();
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(world.closed).toEqual(["tab-1"]);
  expect(world.driving.get("tab-1")).toBeUndefined();
  expect(sent.some((m) => m.id === 2)).toBe(false);
});
