/**
 * A session's Browser as the renderer sees it: main's tab events folded into the tab list and
 * the active tab, and what Output does when an agent opens a tab.
 */
import { Match } from "effect";
import type { BrowserTab, BrowserTabEvent, BrowserTabId } from "../../../shared/browserContract.ts";

export interface BrowserTabs {
  readonly tabs: ReadonlyArray<BrowserTab>;
  readonly active: BrowserTabId | null;
  /** False until main's Snapshot arrives, so "none yet" isn't read as "none at all". */
  readonly ready: boolean;
}

export const NO_TABS: BrowserTabs = { tabs: [], active: null, ready: false };

const fold = (state: BrowserTabs, event: BrowserTabEvent): BrowserTabs =>
  Match.value(event).pipe(
    Match.tagsExhaustive({
      Snapshot: ({ tabs, activeTabId }) => ({ tabs, active: activeTabId, ready: true }),
      // An opened tab is the active one.
      Opened: ({ tab }) => ({
        ...state,
        tabs: [...state.tabs.filter((t) => t.tabId !== tab.tabId), tab],
        active: tab.tabId,
      }),
      Changed: ({ _tag, tabId, ...change }) => ({
        ...state,
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? { tabId: t.tabId, sessionId: t.sessionId, openedBy: t.openedBy, ...change }
            : t
        ),
      }),
      Activated: ({ tabId }) =>
        state.tabs.some((t) => t.tabId === tabId) ? { ...state, active: tabId } : state,
      // Main follows a Closed with the Activated it chose, if any.
      Closed: ({ tabId }) => ({
        ...state,
        tabs: state.tabs.filter((t) => t.tabId !== tabId),
        active: state.active === tabId ? null : state.active,
      }),
    })
  );

export const applyTabEvents = (state: BrowserTabs, events: ReadonlyArray<BrowserTabEvent>) =>
  events.reduce(fold, state);

/** Where Output stands when an agent opens a tab. */
export interface OutputPlace {
  /** The Output panel is showing (not the rail). */
  readonly panelOpen: boolean;
  /** The Browser is the Output tab on screen. */
  readonly browserShown: boolean;
  /** The user closed Output themselves for this session: an agent doesn't reopen it. */
  readonly heldClosed: boolean;
}

/**
 * An agent opened a tab: bring the Browser forward unless the user is in another Output tab (or
 * has closed Output for this session), where the Browser tab shows an activity dot instead.
 */
export const agentOpened = ({ panelOpen, browserShown, heldClosed }: OutputPlace) => {
  if (panelOpen) return browserShown ? "stay" : "dot";

  return heldClosed ? "dot" : "show";
};

/** The tab's label: its title, else its URL without the scheme. */
export const tabLabel = (tab: Pick<BrowserTab, "title" | "url">) => {
  if (tab.title !== null && tab.title.trim() !== "") return tab.title;

  return tab.url.replace(/^https?:\/\//, "").replace(/\/$/, "") || "New tab";
};

/** The URL as the URL bar shows it while not editing: no scheme, no trailing slash alone. */
export const displayUrl = (url: string) =>
  url === "about:blank" ? "" : url.replace(/^https?:\/\//, "").replace(/^([^/]*)\/$/, "$1");
