import { describe, expect, test } from "bun:test";
import { WorkspaceId } from "@polaris/protocol";
import { createStore } from "zustand/vanilla";
import { type AppState, initialState } from "../store/store.ts";
import { hostModel, hostView, workspaces } from "./fixtures.testing.ts";
import { handleOverlayEscape } from "./keyboard.ts";
import { createNavigation, loadNav } from "./navigation.ts";

const memoryStorage = () => {
  const items = new Map<string, string>();

  const storage: Storage = {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => void items.set(k, v),
  };

  return storage;
};

const withData = (counts: Readonly<Record<string, number>>) => {
  const app = createStore<AppState>(() => initialState);

  app.setState({
    hosts: Object.keys(counts).map((k) => hostView(k)),
    hostModels: Object.fromEntries(
      Object.entries(counts).map(([k, n]) => [k, hostModel(workspaces(k, n))])
    ),
  });

  return app;
};

// No animation frames under bun test; the switch timer only needs the function to exist.
globalThis.requestAnimationFrame ??= () => 0;

describe("navigation", () => {
  test("the bar turns into the machine bar at 11 Workspaces, and ⌃N then picks machines", () => {
    const app = createStore<AppState>(() => initialState);
    const nav = createNavigation({ app, storage: null });

    app.setState(withData({ local: 6, studio: 5 }).getState());
    expect(nav.store.getState().topBar).toBe("machines");

    nav.actions.selectShortcut(1);
    // Remote Hosts first, this Mac last: ⌃2 is the local machine.
    expect(nav.current().hostKey).toBe("local");
  });

  test("⌃N in the Workspace bar picks the Nth chip across Hosts", () => {
    const nav = createNavigation({ app: withData({ local: 2, studio: 2 }), storage: null });

    nav.actions.selectShortcut(2);
    expect([nav.current().hostKey, nav.current().workspaceId]).toEqual(["local", "local0"]);
  });

  test("the selection survives a relaunch through storage", async () => {
    const storage = memoryStorage();
    const nav = createNavigation({ app: withData({ local: 3 }), storage });

    nav.actions.selectShortcut(2);
    nav.actions.showSidebar("needs-you");
    nav.actions.setSessionSort("newest");
    await Bun.sleep(350);

    const reloaded = loadNav(storage);

    expect([String(reloaded.workspaceId), reloaded.sidebar, reloaded.sessionSort]).toEqual([
      "local2",
      "needs-you",
      "newest",
    ]);
    expect(loadNav(null).workspaceId).toBeNull();
  });

  test.each(["data", "traces"] as const)(
    "%s stays open across a Workspace switch and a relaunch",
    async (mode) => {
      const storage = memoryStorage();
      const nav = createNavigation({ app: withData({ local: 3 }), storage });

      nav.actions.setMode(mode);
      nav.actions.selectShortcut(2);
      expect(nav.current().mode).toBe(mode);
      await Bun.sleep(350);
      expect(loadNav(storage).mode).toBe(mode);
    }
  );

  test("the resolved selection is the same object until it changes", () => {
    const nav = createNavigation({ app: withData({ local: 2 }), storage: null });
    const first = nav.current();

    nav.actions.setJumpOpen(true);
    expect(nav.current()).toBe(first);
    nav.actions.selectShortcut(1);
    expect(nav.current()).not.toBe(first);
  });

  test("Settings opens over where the user was, remembers its section, and esc returns", () => {
    const nav = createNavigation({ app: withData({ local: 3 }), storage: null });

    nav.actions.selectShortcut(1);
    nav.actions.openSettings();
    expect(nav.current().settings).toEqual({ section: "appearance", adding: false });
    nav.actions.openSettings("hosts", { adding: true });
    expect(nav.current().settings).toEqual({ section: "hosts", adding: true });
    nav.actions.closeSettings();
    expect(nav.current().settings).toBeNull();
    expect(String(nav.current().workspaceId)).toBe("local1");
    nav.actions.openSettings();
    expect(nav.current().settings?.section).toBe("hosts");
  });

  test("moving elsewhere closes Settings", () => {
    const nav = createNavigation({ app: withData({ local: 2 }), storage: null });

    nav.actions.openSettings("usage");
    nav.actions.setMode("orchestrate");
    expect(nav.current().settings).toBeNull();
    nav.actions.openSettings("usage");
    nav.actions.selectShortcut(1);
    expect(nav.current().settings).toBeNull();
  });

  test("a new session with no Workspace falls back to the one onboarding makes", async () => {
    const app = withData({ local: 0 });
    const asked: Array<string> = [];

    const nav = createNavigation({
      app,
      storage: null,
      ensureWorkspace: (hostKey) => {
        asked.push(hostKey);
        app.setState(withData({ local: 1 }).getState());

        return Promise.resolve(WorkspaceId.make("local0"));
      },
    });

    expect(nav.current().workspaceId).toBeNull();
    nav.actions.startNewSession();
    expect(nav.current().pane).toBe("new-session");
    await Promise.resolve();
    await Promise.resolve();

    expect(asked).toEqual(["local"]);
    expect(nav.current()).toMatchObject({ workspaceId: "local0", pane: "new-session" });
  });

  test("when no Workspace can be made, the stage goes back to the setup", async () => {
    const nav = createNavigation({
      app: withData({ local: 0 }),
      storage: null,
      ensureWorkspace: () => Promise.resolve(null),
    });

    nav.actions.startNewSession();
    await Promise.resolve();
    await Promise.resolve();

    expect(nav.current()).toMatchObject({ workspaceId: null, pane: "session" });
  });

  test("with a Workspace selected, a new session asks for nothing", () => {
    const asked: Array<string> = [];

    const nav = createNavigation({
      app: withData({ local: 2 }),
      storage: null,
      ensureWorkspace: (hostKey) => {
        asked.push(hostKey);

        return Promise.resolve(null);
      },
    });

    nav.actions.startNewSession();
    expect(asked).toEqual([]);
    expect(nav.current()).toMatchObject({ workspaceId: "local0", pane: "new-session" });
  });
});

describe("new session on another Host", () => {
  test("a remote Host with Workspaces: its first, with nothing asked", () => {
    const asked: Array<string> = [];

    const nav = createNavigation({
      app: withData({ local: 2, studio: 1 }),
      storage: null,
      ensureWorkspace: (hostKey) => {
        asked.push(hostKey);

        return Promise.resolve(null);
      },
    });

    nav.actions.selectWorkspace({ hostKey: "local", workspaceId: WorkspaceId.make("local1") });
    nav.actions.startNewSessionIn("studio", WorkspaceId.make("studio0"));
    expect(asked).toEqual([]);
    expect(nav.current()).toMatchObject({
      hostKey: "studio",
      workspaceId: "studio0",
      pane: "new-session",
    });
  });

  test("a remote Host with no Workspace: its home, while a local Workspace is selected", async () => {
    const app = withData({ local: 2, studio: 0 });
    const asked: Array<string> = [];

    const nav = createNavigation({
      app,
      storage: null,
      ensureWorkspace: (hostKey) => {
        asked.push(hostKey);

        return Promise.resolve().then(() => {
          app.setState(withData({ local: 2, studio: 1 }).getState());

          return WorkspaceId.make("studio0");
        });
      },
    });

    nav.actions.selectWorkspace({ hostKey: "local", workspaceId: WorkspaceId.make("local0") });
    nav.actions.startNewSessionIn("studio");
    // Meanwhile the stage is the remote Host's, busy.
    expect(nav.current()).toMatchObject({ hostKey: "studio", workspaceId: null });
    await new Promise((r) => setTimeout(r, 0));

    expect(asked).toEqual(["studio"]);
    expect(nav.current()).toMatchObject({
      hostKey: "studio",
      workspaceId: "studio0",
      pane: "new-session",
    });
  });

  test("moving on before the home arrives keeps where the user went", async () => {
    const app = withData({ local: 1, studio: 0 });
    let resolve: (id: WorkspaceId | null) => void = () => undefined;

    const nav = createNavigation({
      app,
      storage: null,
      ensureWorkspace: () => new Promise((r) => (resolve = r)),
    });

    nav.actions.startNewSessionIn("studio");
    nav.actions.startNewSessionIn("local", WorkspaceId.make("local0"));
    resolve(WorkspaceId.make("studio0"));
    await Promise.resolve();
    await Promise.resolve();
    expect(nav.current()).toMatchObject({ hostKey: "local", workspaceId: "local0" });
  });
});

describe("shell overlays", () => {
  test("one at a time: opening one closes the other; Escape closes whichever is open", () => {
    const nav = createNavigation({ app: withData({ local: 1 }), storage: null });
    const open = () => [nav.store.getState().jumpOpen, nav.store.getState().helpOpen];

    nav.actions.openJump();
    nav.actions.setHelpOpen(true);
    expect(open()).toEqual([false, true]);
    nav.actions.openJump();
    expect(open()).toEqual([true, false]);
    expect(handleOverlayEscape({ key: "Escape", isComposing: false }, nav.actions)).toBe(true);
    expect(open()).toEqual([false, false]);
    expect(handleOverlayEscape({ key: "Escape", isComposing: false }, nav.actions)).toBe(false);
  });

  test("the ⌘O dialog is one of them, on the Host asked for", () => {
    const nav = createNavigation({ app: withData({ local: 1, studio: 1 }), storage: null });

    nav.actions.openJump();
    nav.actions.openFolder("studio");
    expect(nav.store.getState()).toMatchObject({ jumpOpen: false, folder: { hostKey: "studio" } });
    nav.actions.setHelpOpen(true);
    expect(nav.store.getState().folder).toBeNull();
    nav.actions.openFolder();
    expect(handleOverlayEscape({ key: "Escape", isComposing: false }, nav.actions)).toBe(true);
    expect(nav.store.getState().folder).toBeNull();
  });

  test("Escape during IME composition, or another key, leaves the overlay open", () => {
    const nav = createNavigation({ app: withData({ local: 1 }), storage: null });

    nav.actions.openJump();
    expect(handleOverlayEscape({ key: "Escape", isComposing: true }, nav.actions)).toBe(false);
    expect(handleOverlayEscape({ key: "k", isComposing: false }, nav.actions)).toBe(false);
    expect(nav.store.getState().jumpOpen).toBe(true);
  });
});
