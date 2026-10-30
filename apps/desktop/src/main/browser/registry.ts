/**
 * Every Agent Session's Browser in main: its tabs (`tabs.ts`), the views behind them (`ViewHost`,
 * Electron in `views.ts`), which session is on screen and claimed on its Host, and what is kept
 * across restarts. Tabs are resolved only here, always with the session the caller named.
 */
import type { SessionId, WorkspaceId } from "@polaris/protocol";
import { Predicate } from "effect";
import {
  type BrowserBounds,
  type BrowserPickResult,
  type BrowserTab,
  type BrowserTabChange,
  BrowserTabEvent,
  type BrowserTabId,
  type BrowserTabOpener,
} from "../../shared/browserContract.ts";
import { urlFromInput } from "./navigation.ts";
import {
  activated,
  changed,
  emptyTabs,
  MAX_TABS,
  findTab,
  kept,
  type KeptSession,
  keyOf,
  newTab,
  remembered,
  restored,
  sessionKey,
  type SessionTabs,
  withoutTab,
  withTab,
} from "./tabs.ts";

/** A request named a tab, URL or session main won't act on. */
export class BrowserRefused extends Error {
  readonly code = "BrowserRefused";
}

export type TabChange = typeof BrowserTabChange.Type;

/** The views behind tabs: Electron in the app, a fake in tests. */
export interface ViewHost {
  /** Creates the tab's view in its Workspace's partition and loads `tab.url`; once per tab. */
  readonly create: (tab: BrowserTab, place: { hostKey: string; workspaceId: WorkspaceId }) => void;
  readonly load: (tabId: BrowserTabId, url: string) => void;
  readonly back: (tabId: BrowserTabId) => void;
  readonly forward: (tabId: BrowserTabId) => void;
  readonly reload: (tabId: BrowserTabId, ignoreCache: boolean) => void;
  readonly devtools: (tabId: BrowserTabId, open: boolean) => void;
  /** Pick mode in the tab: the clicked element, or null when cancelled (ENG-618). */
  readonly pick: (tabId: BrowserTabId) => Promise<BrowserPickResult | null>;
  /** Ends the tab's pick mode; its `pick` answers null. */
  readonly cancelPick: (tabId: BrowserTabId) => void;
  /** Puts the tab on screen at `bounds` (empty bounds cover it), every other view off it. */
  readonly show: (tabId: BrowserTabId, bounds: BrowserBounds) => void;
  /** Takes every view off screen. */
  readonly hideAll: () => void;
  readonly destroy: (tabId: BrowserTabId) => void;
}

/** `browser.claim` and `browser.release` on the session's Host; failures are the caller's to log. */
export interface Hosting {
  readonly claim: (hostKey: string, sessionId: SessionId) => void;
  readonly release: (hostKey: string, sessionId: SessionId) => void;
}

export interface RegistryDeps {
  readonly views: ViewHost;
  readonly hosting: Hosting;
  /** Kept sessions as last saved, the least recently changed first. */
  readonly kept: ReadonlyArray<KeptSession>;
  readonly save: (sessions: ReadonlyArray<KeptSession>) => void;
  readonly nextId: () => BrowserTabId;
  /** The session's Workspace as its Host has it, or null for a session the Host doesn't know. */
  readonly workspaceOf: (hostKey: string, sessionId: SessionId) => Promise<WorkspaceId | null>;
}

export interface OpenTab {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  /** The Workspace the caller expects; refused unless it is the session's own. */
  readonly workspaceId?: WorkspaceId | undefined;
  readonly url: string;
  readonly openedBy: BrowserTabOpener;
}

type Listener = (event: BrowserTabEvent) => void;

export const createRegistry = (deps: RegistryDeps) => {
  const sessions = new Map<string, SessionTabs>();
  const listeners = new Map<string, Set<Listener>>();
  const created = new Set<BrowserTabId>();
  let keptSessions = deps.kept;

  let shown: {
    readonly key: string;
    readonly hostKey: string;
    readonly sessionId: SessionId;
    readonly bounds: BrowserBounds;
  } | null = null;

  const emit = (key: string, event: BrowserTabEvent) => {
    for (const listener of listeners.get(key) ?? []) listener(event);
  };

  const keep = (state: SessionTabs) => {
    keptSessions = remembered(keptSessions, keyOf(state), kept(state));
    deps.save(keptSessions);
  };

  /** The session's tabs, restored from what was kept the first time they are asked for. */
  const stateOf = (hostKey: string, sessionId: SessionId): SessionTabs | null => {
    const key = sessionKey(hostKey, sessionId);
    const live = sessions.get(key);

    if (live !== undefined) return live;

    const saved = keptSessions.find((session) => keyOf(session) === key);

    if (saved === undefined) return null;

    const state = restored(saved, deps.nextId);

    sessions.set(key, state);

    return state;
  };

  const set = (state: SessionTabs) => {
    sessions.set(keyOf(state), state);
    keep(state);
  };

  const ensureView = (state: SessionTabs, tab: BrowserTab) => {
    if (created.has(tab.tabId)) return;
    created.add(tab.tabId);
    deps.views.create(tab, { hostKey: state.hostKey, workspaceId: state.workspaceId });
  };

  /** Puts the shown session's active tab on screen, creating its view on first sight. */
  const paint = () => {
    if (shown === null) return deps.views.hideAll();

    const state = sessions.get(shown.key);
    const tab = state?.active == null ? null : findTab(state, state.active);

    if (state === undefined || tab === null) return deps.views.hideAll();
    ensureView(state, tab);
    deps.views.show(tab.tabId, shown.bounds);
  };

  /** The tab, only when it belongs to the session the caller named. */
  const owned = (hostKey: string, sessionId: SessionId, tabId: BrowserTabId) => {
    const state = stateOf(hostKey, sessionId);
    const tab = state === null ? null : findTab(state, tabId);

    if (state === null || tab === null) throw new BrowserRefused("No such tab in this session");

    return { state, tab };
  };

  const openTab = async ({ hostKey, sessionId, workspaceId, url, openedBy }: OpenTab) => {
    const target = urlFromInput(url);

    if (target === null) throw new BrowserRefused(`A tab can't open ${url}`);

    const existing = stateOf(hostKey, sessionId);

    // Main asks the Host, never the caller, which partition a session's first tab gets.
    const workspace = existing?.workspaceId ?? (await deps.workspaceOf(hostKey, sessionId));

    if (workspace === null) throw new BrowserRefused("No such session");

    if (workspaceId !== undefined && workspaceId !== workspace)
      throw new BrowserRefused("This session's Browser is in another workspace");

    const before = stateOf(hostKey, sessionId) ?? emptyTabs(hostKey, sessionId, workspace);

    if (before.tabs.length >= MAX_TABS) throw new BrowserRefused("This session has too many tabs");

    const tab = newTab(deps.nextId(), sessionId, target, openedBy);
    const state = withTab(before, tab);

    set(state);
    emit(
      keyOf(state),
      BrowserTabEvent.cases.Opened.make({ tab, byAgent: !Predicate.isTagged(openedBy, "User") })
    );
    // Agents drive their tabs at once, on screen or not.
    ensureView(state, tab);
    paint();

    return tab;
  };

  const closeTab = (hostKey: string, sessionId: SessionId, tabId: BrowserTabId) => {
    const { state } = owned(hostKey, sessionId, tabId);
    const next = withoutTab(state, tabId);

    set(next);

    if (created.delete(tabId)) deps.views.destroy(tabId);
    emit(keyOf(next), BrowserTabEvent.cases.Closed.make({ tabId }));

    if (next.active !== null && next.active !== state.active)
      emit(keyOf(next), BrowserTabEvent.cases.Activated.make({ tabId: next.active }));

    paint();
  };

  const activateTab = (hostKey: string, sessionId: SessionId, tabId: BrowserTabId) => {
    const { state } = owned(hostKey, sessionId, tabId);

    if (state.active === tabId) return;
    set(activated(state, tabId));
    emit(keyOf(state), BrowserTabEvent.cases.Activated.make({ tabId }));
    paint();
  };

  /** A view reported a change: the tab's model follows it. */
  const tabChanged = (tabId: BrowserTabId, change: Partial<TabChange>) => {
    for (const state of sessions.values()) {
      const tab = findTab(state, tabId);

      if (tab === null) continue;

      const full: TabChange = {
        url: change.url ?? tab.url,
        title: change.title === undefined ? tab.title : change.title,
        loading: change.loading ?? tab.loading,
        canGoBack: change.canGoBack ?? tab.canGoBack,
        canGoForward: change.canGoForward ?? tab.canGoForward,
        hostAddress: change.hostAddress ?? tab.hostAddress,
        agentDriving: change.agentDriving ?? tab.agentDriving,
      };

      const next = changed(state, tabId, full);

      if (full.url === tab.url && full.title === tab.title) sessions.set(keyOf(next), next);
      else set(next);

      emit(keyOf(next), BrowserTabEvent.cases.Changed.make({ tabId, ...full }));

      return;
    }
  };

  /** Shows the session's Browser; claims it on its Host when it wasn't the one on screen. */
  const show = (hostKey: string, sessionId: SessionId, bounds: BrowserBounds) => {
    const key = sessionKey(hostKey, sessionId);

    stateOf(hostKey, sessionId);

    if (shown?.key !== key) {
      if (shown !== null) deps.hosting.release(shown.hostKey, shown.sessionId);
      deps.hosting.claim(hostKey, sessionId);
    }

    shown = { key, hostKey, sessionId, bounds };
    paint();
  };

  const hide = (hostKey: string, sessionId: SessionId) => {
    const key = sessionKey(hostKey, sessionId);

    if (shown?.key !== key) return;
    deps.hosting.release(hostKey, sessionId);
    shown = null;
    paint();
  };

  /** Closes archived sessions' tabs and forgets them. */
  const forget = (hostKey: string, sessionIds: ReadonlyArray<SessionId>) => {
    for (const sessionId of sessionIds) {
      const key = sessionKey(hostKey, sessionId);
      const state = sessions.get(key);

      for (const tab of state?.tabs ?? [])
        if (created.delete(tab.tabId)) deps.views.destroy(tab.tabId);
      sessions.delete(key);

      if (shown?.key === key) hide(hostKey, sessionId);

      if (state !== undefined || keptSessions.some((s) => keyOf(s) === key)) {
        keptSessions = remembered(keptSessions, key, null);
        deps.save(keptSessions);
      }

      for (const tab of state?.tabs ?? [])
        emit(key, BrowserTabEvent.cases.Closed.make({ tabId: tab.tabId }));
    }
  };

  const subscribe = (hostKey: string, sessionId: SessionId, listener: Listener) => {
    const key = sessionKey(hostKey, sessionId);
    const state = stateOf(hostKey, sessionId);
    const group = listeners.get(key) ?? new Set();

    listeners.set(key, group.add(listener));
    listener(
      BrowserTabEvent.cases.Snapshot.make({
        tabs: state?.tabs ?? [],
        activeTabId: state?.active ?? null,
      })
    );

    return () => {
      group.delete(listener);

      if (group.size === 0) listeners.delete(key);
    };
  };

  /** The session's tab that owns a view, for the view's own events (popups). */
  const sessionOfTab = (tabId: BrowserTabId) => {
    for (const state of sessions.values()) if (findTab(state, tabId) !== null) return state;

    return null;
  };

  /** Sessions mid-Turn, by `sessionKey`: only their tabs can be an agent's (`setWorking`). */
  let working = new Set<string>();

  /** An agent drives a tab only during its session's Turn; a Turn's end clears it. */
  const setAgentDriving = (tabId: BrowserTabId, agentDriving: boolean) => {
    const state = sessionOfTab(tabId);
    const tab = state === null ? null : findTab(state, tabId);

    if (state === null || tab === null || tab.agentDriving === agentDriving) return;

    if (agentDriving && !working.has(keyOf(state))) return;
    tabChanged(tabId, { agentDriving });
  };

  /** The sessions mid-Turn now; tabs of a session whose Turn ended stop being driven. */
  const setWorking = (now: ReadonlyArray<{ hostKey: string; sessionId: SessionId }>) => {
    const next = new Set(now.map(({ hostKey, sessionId }) => sessionKey(hostKey, sessionId)));
    const ended = [...working].filter((key) => !next.has(key));

    working = next;

    for (const key of ended)
      for (const tab of sessions.get(key)?.tabs ?? [])
        if (tab.agentDriving) tabChanged(tab.tabId, { agentDriving: false });
  };

  /** The tab's id once its view exists, when it is in the named session. */
  const viewOf = (hostKey: string, sessionId: SessionId, tabId: BrowserTabId) => {
    const { state, tab } = owned(hostKey, sessionId, tabId);

    ensureView(state, tab);

    return tab.tabId;
  };

  const navigate = (hostKey: string, sessionId: SessionId, tabId: BrowserTabId, input: string) => {
    const url = urlFromInput(input);

    if (url === null) throw new BrowserRefused(`A tab can't open ${input}`);
    deps.views.load(viewOf(hostKey, sessionId, tabId), url);
  };

  return {
    openTab,
    closeTab,
    navigate,
    back: (hostKey: string, sessionId: SessionId, tabId: BrowserTabId) =>
      deps.views.back(viewOf(hostKey, sessionId, tabId)),
    forward: (hostKey: string, sessionId: SessionId, tabId: BrowserTabId) =>
      deps.views.forward(viewOf(hostKey, sessionId, tabId)),
    reload: (hostKey: string, sessionId: SessionId, tabId: BrowserTabId, ignoreCache: boolean) =>
      deps.views.reload(viewOf(hostKey, sessionId, tabId), ignoreCache),
    devtools: (hostKey: string, sessionId: SessionId, tabId: BrowserTabId, open: boolean) =>
      deps.views.devtools(viewOf(hostKey, sessionId, tabId), open),
    pick: (hostKey: string, sessionId: SessionId, tabId: BrowserTabId) =>
      deps.views.pick(viewOf(hostKey, sessionId, tabId)),
    cancelPick: (hostKey: string, sessionId: SessionId, tabId: BrowserTabId) =>
      deps.views.cancelPick(viewOf(hostKey, sessionId, tabId)),
    activateTab,
    tabChanged,
    show,
    hide,
    forget,
    subscribe,
    sessionOfTab,
    sessionTabs: (hostKey: string, sessionId: SessionId) => {
      const state = stateOf(hostKey, sessionId);

      return { tabs: state?.tabs ?? [], activeTabId: state?.active ?? null };
    },
    setAgentDriving,
    setWorking,
    workspaceOf: (hostKey: string, sessionId: SessionId) =>
      stateOf(hostKey, sessionId)?.workspaceId ?? null,
  };
};

export type Registry = ReturnType<typeof createRegistry>;
