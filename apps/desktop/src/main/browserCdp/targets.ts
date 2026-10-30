/**
 * The facade's view of one session's tabs as CDP targets (ENG-616): which tabs it knows,
 * which it is attached to under which session id, and the nested sessions (frames, workers)
 * Chromium opened under them. Target ids are tab ids; session ids are the facade's own.
 */
import type { SessionId } from "@polaris/protocol";
import type { BrowserTab, BrowserTabId } from "../../shared/browserContract.ts";
import type { DebuggerHub } from "./hub.ts";

/** `Target.TargetInfo` for a tab; a type alias, so it is JSON to the message schema. */
export type TargetInfo = {
  readonly targetId: string;
  readonly type: "page";
  readonly title: string;
  readonly url: string;
  readonly attached: boolean;
  readonly canAccessOpener: false;
  readonly browserContextId: string;
};

interface Attached {
  readonly sessionId: string;
  readonly tabId: BrowserTabId;
  readonly hub: DebuggerHub;
  readonly release: () => void;
}

export interface Route {
  readonly tabId: BrowserTabId;
  readonly hub: DebuggerHub;
  /** Chromium's id of a nested session under the tab, or null for the tab itself. */
  readonly nested: string | null;
}

export class Targets {
  readonly known = new Map<BrowserTabId, BrowserTab>();
  private readonly byTab = new Map<BrowserTabId, Attached>();
  private readonly bySession = new Map<string, Attached>();
  private readonly nested = new Map<string, Attached>();

  constructor(private readonly sessionId: SessionId) {}

  infoOf(tab: BrowserTab): TargetInfo {
    return {
      targetId: tab.tabId,
      type: "page",
      title: tab.title ?? tab.url,
      url: tab.url,
      attached: this.byTab.has(tab.tabId),
      canAccessOpener: false,
      browserContextId: `polaris:${this.sessionId}`,
    };
  }

  infos(): ReadonlyArray<TargetInfo> {
    return [...this.known.values()].map((tab) => this.infoOf(tab));
  }

  attachedTo(tabId: BrowserTabId): string | null {
    return this.byTab.get(tabId)?.sessionId ?? null;
  }

  /** Records a session the caller attached; `release` is the hub's. */
  attached(tabId: BrowserTabId, hub: DebuggerHub, release: () => void): string {
    const sessionId = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const entry: Attached = { sessionId, tabId, hub, release };
    this.byTab.set(tabId, entry);
    this.bySession.set(sessionId, entry);

    return sessionId;
  }

  /** Forgets the session, releasing the hub; answers its tab, or null for an unknown id. */
  detach(sessionId: string): { tabId: BrowserTabId; hub: DebuggerHub } | null {
    const entry = this.bySession.get(sessionId);

    if (entry === undefined) return null;
    this.bySession.delete(sessionId);
    this.byTab.delete(entry.tabId);

    for (const [child, owner] of this.nested) if (owner === entry) this.nested.delete(child);
    entry.release();

    return { tabId: entry.tabId, hub: entry.hub };
  }

  sessionsOn(tabId: BrowserTabId): ReadonlyArray<string> {
    const entry = this.byTab.get(tabId);

    return entry === undefined ? [] : [entry.sessionId];
  }

  /** Chromium attached a nested session under the tab's session. */
  nestedOpened(ownerSessionId: string, nestedSessionId: string): void {
    const owner = this.bySession.get(ownerSessionId);

    if (owner !== undefined) this.nested.set(nestedSessionId, owner);
  }

  nestedClosed(nestedSessionId: string): void {
    this.nested.delete(nestedSessionId);
  }

  /** Where a command with `sessionId` goes, or null when the facade knows no such session. */
  routeOf(sessionId: string): Route | null {
    const top = this.bySession.get(sessionId);

    if (top !== undefined) return { tabId: top.tabId, hub: top.hub, nested: null };
    const owner = this.nested.get(sessionId);

    return owner === undefined ? null : { tabId: owner.tabId, hub: owner.hub, nested: sessionId };
  }

  allSessions(): ReadonlyArray<string> {
    return [...this.bySession.keys()];
  }
}
