/**
 * The Browser over IPC (ENG-615, ENG-618, ADR 0092): main owns each Agent Session's tabs as
 * WebContentsViews in the Workspace's partition; the renderer drives them and lays out the
 * visible one. A tab is always named with its session, and main refuses a tab of another one.
 */
import { SessionId, SubagentId, WorkspaceId } from "@polaris/protocol";
import { Schema } from "effect";

const HostKey = Schema.String.check(Schema.isMinLength(1));

/** A Browser tab, chosen by main when it opens one; unique in the Desktop App. */
export const BrowserTabId = Schema.String.pipe(Schema.brand("BrowserTabId"));

export type BrowserTabId = typeof BrowserTabId.Type;

/** Where the visible tab's WebContentsView goes, in the window's content coordinates (CSS px). */
export const BrowserBounds = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type BrowserBounds = typeof BrowserBounds.Type;

/** Who opened a tab: the user, the session's agent, or one of its Subagents (the tab's label). */
export const BrowserTabOpener = Schema.TaggedUnion({
  User: {},
  Agent: {},
  Subagent: { subagentId: SubagentId, name: Schema.String },
});

export type BrowserTabOpener = typeof BrowserTabOpener.Type;

export class BrowserTab extends Schema.Class<BrowserTab>("BrowserTab")({
  tabId: BrowserTabId,
  sessionId: SessionId,
  url: Schema.String,
  /** The page's title, or null before it has one. */
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  /** The URL is a Host address: the URL bar shows the "Host address" badge, not the padlock. */
  hostAddress: Schema.Boolean,
  /** An agent is driving the tab over CDP right now: the tab shows its indicator. */
  agentDriving: Schema.Boolean,
  openedBy: BrowserTabOpener,
}) {}

/** The parts of a tab that change after it opens. */
export const BrowserTabChange = Schema.Struct({
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  hostAddress: Schema.Boolean,
  agentDriving: Schema.Boolean,
});

/**
 * One session's tabs as they change. `Snapshot` comes first, in tab order; `Opened` with
 * `byAgent` lets the Output bring the Browser to the front or show its activity dot.
 */
export const BrowserTabEvent = Schema.TaggedUnion({
  Snapshot: { tabs: Schema.Array(BrowserTab), activeTabId: Schema.NullOr(BrowserTabId) },
  Opened: { tab: BrowserTab, byAgent: Schema.Boolean },
  Changed: { tabId: BrowserTabId, ...BrowserTabChange.fields },
  Activated: { tabId: BrowserTabId },
  Closed: { tabId: BrowserTabId },
});

export type BrowserTabEvent = typeof BrowserTabEvent.Type;

/** What a pick captured, staged with `attachments.stage` as the composer's chip (ENG-618). */
export class BrowserPickResult extends Schema.Class<BrowserPickResult>("BrowserPickResult")({
  url: Schema.String,
  title: Schema.String,
  /** A CSS selector that matches the picked element. */
  selector: Schema.String,
  /** The element's outer HTML, cut to a bounded excerpt. */
  html: Schema.String,
  /** A PNG of the element's bounds. */
  screenshot: Schema.Uint8Array,
}) {}

const OnTab = Schema.Struct({ hostKey: HostKey, sessionId: SessionId, tabId: BrowserTabId });

export const BrowserRequestInputs = {
  /** Opens a tab in the session's Browser and makes it active; `url` may be a Host address. */
  "browser.openTab": Schema.Struct({
    hostKey: HostKey,
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    url: Schema.String,
  }),
  "browser.closeTab": OnTab,
  "browser.activateTab": OnTab,
  /** `url` as typed in the URL bar: main adds the scheme and refuses what isn't http(s). */
  "browser.navigate": Schema.Struct({ ...OnTab.fields, url: Schema.String }),
  "browser.back": OnTab,
  "browser.forward": OnTab,
  /** `ignoreCache` is a hard reload. */
  "browser.reload": Schema.Struct({ ...OnTab.fields, ignoreCache: Schema.Boolean }),
  /** The session's tabs now, in tab order. */
  "browser.listTabs": Schema.Struct({ hostKey: HostKey, sessionId: SessionId }),
  /**
   * Shows the session's active tab at `bounds`, and claims its Browser on the Host
   * (`browser.claim`); called again as the Output resizes. Empty bounds cover it (a menu
   * over the Browser) and keep the claim.
   */
  "browser.show": Schema.Struct({ hostKey: HostKey, sessionId: SessionId, bounds: BrowserBounds }),
  /** Hides the session's Browser and releases it (`browser.release`); its tabs stay open. */
  "browser.hide": Schema.Struct({ hostKey: HostKey, sessionId: SessionId }),
  "browser.devtools": Schema.Struct({ ...OnTab.fields, open: Schema.Boolean }),
  /**
   * Starts pick mode in the tab; answers the pick, or null when the user cancels it, the tab
   * navigates, hides or closes, or `browser.cancelPick` ends it.
   */
  "browser.pick": OnTab,
  "browser.cancelPick": OnTab,
  /** Closes these sessions' tabs and forgets them: the renderer names sessions once archived. */
  "browser.forget": Schema.Struct({ hostKey: HostKey, sessionIds: Schema.Array(SessionId) }),
  /** Every session mid-Turn: an agent drives a tab only during its session's Turn. */
  "browser.working": Schema.Struct({
    sessions: Schema.Array(Schema.Struct({ hostKey: HostKey, sessionId: SessionId })),
  }),
} as const;

export type BrowserMethod = keyof typeof BrowserRequestInputs;

export interface BrowserRequestOutputs {
  readonly "browser.openTab": BrowserTab;
  readonly "browser.closeTab": null;
  readonly "browser.activateTab": null;
  readonly "browser.navigate": null;
  readonly "browser.back": null;
  readonly "browser.forward": null;
  readonly "browser.reload": null;
  readonly "browser.listTabs": ReadonlyArray<BrowserTab>;
  readonly "browser.show": null;
  readonly "browser.hide": null;
  readonly "browser.devtools": null;
  readonly "browser.pick": BrowserPickResult | null;
  readonly "browser.cancelPick": null;
  readonly "browser.forget": null;
  readonly "browser.working": null;
}

export const BrowserSubscriptionInputs = {
  /** One session's tabs (`BrowserTabEvent`): a `Snapshot`, then each change. */
  "browser.tabs": Schema.Struct({ hostKey: HostKey, sessionId: SessionId }),
} as const;

export interface BrowserSubscriptionItems {
  readonly "browser.tabs": BrowserTabEvent;
}
