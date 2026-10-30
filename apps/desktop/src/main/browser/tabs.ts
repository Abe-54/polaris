/**
 * One Agent Session's Browser tabs as data: their order, the active one, and the form they are
 * kept in across restarts (`<userData>/browser/tabs.json`, the most recently changed sessions).
 */
import { SessionId, WorkspaceId } from "@polaris/protocol";
import { Schema } from "effect";
import {
  BrowserTab,
  type BrowserTabChange,
  type BrowserTabId,
  BrowserTabOpener,
} from "../../shared/browserContract.ts";
import { allowedUrl, isHostAddress } from "./navigation.ts";

export interface SessionTabs {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly tabs: ReadonlyArray<BrowserTab>;
  readonly active: BrowserTabId | null;
}

export const sessionKey = (hostKey: string, sessionId: string) => `${hostKey}\u0000${sessionId}`;

export const keyOf = (tabs: Pick<SessionTabs, "hostKey" | "sessionId">) =>
  sessionKey(tabs.hostKey, tabs.sessionId);

export const emptyTabs = (
  hostKey: string,
  sessionId: SessionId,
  workspaceId: WorkspaceId
): SessionTabs => ({ hostKey, sessionId, workspaceId, tabs: [], active: null });

/** A session's tabs at most, so a page opening popups can't open views without end. */
export const MAX_TABS = 24;

/** A tab just opened at `url`, before its first load. */
export const newTab = (
  tabId: BrowserTabId,
  sessionId: SessionId,
  url: string,
  openedBy: BrowserTabOpener,
  title: string | null = null
) =>
  new BrowserTab({
    tabId,
    sessionId,
    url,
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    hostAddress: isHostAddress(url),
    agentDriving: false,
    openedBy,
  });

/** `tab` added at the end and made active. */
export const withTab = (state: SessionTabs, tab: BrowserTab): SessionTabs => ({
  ...state,
  tabs: [...state.tabs, tab],
  active: tab.tabId,
});

/** `tabId` closed; when it was active, its right neighbour (else its left) becomes active. */
export const withoutTab = (state: SessionTabs, tabId: BrowserTabId): SessionTabs => {
  const index = state.tabs.findIndex((tab) => tab.tabId === tabId);

  if (index === -1) return state;

  const tabs = state.tabs.toSpliced(index, 1);
  const next = tabs[index] ?? tabs[index - 1] ?? null;

  return { ...state, tabs, active: state.active === tabId ? (next?.tabId ?? null) : state.active };
};

export const activated = (state: SessionTabs, tabId: BrowserTabId): SessionTabs =>
  state.tabs.some((tab) => tab.tabId === tabId) ? { ...state, active: tabId } : state;

export const changed = (
  state: SessionTabs,
  tabId: BrowserTabId,
  change: typeof BrowserTabChange.Type
): SessionTabs => ({
  ...state,
  tabs: state.tabs.map((tab) =>
    tab.tabId === tabId
      ? new BrowserTab({
          tabId: tab.tabId,
          sessionId: tab.sessionId,
          openedBy: tab.openedBy,
          ...change,
        })
      : tab
  ),
});

export const findTab = (state: SessionTabs, tabId: BrowserTabId) =>
  state.tabs.find((tab) => tab.tabId === tabId) ?? null;

// ── Kept across restarts ────────────────────────────────────────────────────

const KeptTab = Schema.Struct({
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  openedBy: BrowserTabOpener,
});

export const KeptSession = Schema.Struct({
  hostKey: Schema.String,
  sessionId: SessionId,
  workspaceId: WorkspaceId,
  tabs: Schema.Array(KeptTab),
  /** The active tab's index, or null. */
  active: Schema.NullOr(Schema.Int),
});

export type KeptSession = typeof KeptSession.Type;

/** Every kept session, the least recently changed first. */
export const KeptFile = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(KeptSession),
});

/** Sessions whose tabs are kept; the least recently changed go first. */
export const KEPT_SESSIONS = 200;

export const kept = (state: SessionTabs): KeptSession | null => {
  if (state.tabs.length === 0) return null;

  const active = state.tabs.findIndex((tab) => tab.tabId === state.active);

  return {
    hostKey: state.hostKey,
    sessionId: state.sessionId,
    workspaceId: state.workspaceId,
    tabs: state.tabs.map(({ url, title, openedBy }) => ({ url, title, openedBy })),
    active: active === -1 ? null : active,
  };
};

/** A kept session's tabs again, under fresh ids; a URL no tab may load now, or past the cap, is dropped. */
export const restored = (session: KeptSession, nextId: () => BrowserTabId): SessionTabs => {
  const pairs = session.tabs
    .flatMap((tab, index) =>
      allowedUrl(tab.url)
        ? [{ index, tab: newTab(nextId(), session.sessionId, tab.url, tab.openedBy, tab.title) }]
        : []
    )
    .slice(0, MAX_TABS);

  const active = pairs.find(({ index }) => index === session.active) ?? pairs[0] ?? null;

  return {
    hostKey: session.hostKey,
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    tabs: pairs.map(({ tab }) => tab),
    active: active?.tab.tabId ?? null,
  };
};

/** `entry` kept as the newest for its session (or dropped when null), oldest past `limit` gone. */
export const remembered = (
  sessions: ReadonlyArray<KeptSession>,
  key: string,
  entry: KeptSession | null,
  limit = KEPT_SESSIONS
): ReadonlyArray<KeptSession> => {
  const rest = sessions.filter((session) => keyOf(session) !== key);
  const all = entry === null ? rest : [...rest, entry];

  return all.slice(Math.max(0, all.length - limit));
};
