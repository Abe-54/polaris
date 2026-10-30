/**
 * What the CDP facade needs from the Browser (ENG-616): the session's tabs as `Browsers`
 * (`../browser`) keeps them, and each tab's `webContents.debugger`. Ports, so the facade
 * tests with fakes and `Browsers` stays the Browser's one owner.
 */
import type { CdpJson, SessionId } from "@polaris/protocol";
import type { Event as ElectronEvent } from "electron";
import type {
  BrowserTab,
  BrowserTabEvent,
  BrowserTabId,
  BrowserTabOpener,
} from "../../shared/browserContract.ts";

/** The part of Electron's `Debugger` the facade drives; `webContents.debugger` satisfies it. */
export type DetachListener = (event: ElectronEvent, reason: string) => void;

export type MessageListener = (
  event: ElectronEvent,
  method: string,
  params: CdpJson,
  sessionId: string
) => void;

export interface CdpDebuggee {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, commandParams?: CdpJson, sessionId?: string): Promise<CdpJson>;
  on(event: "detach", listener: DetachListener): this;
  on(event: "message", listener: MessageListener): this;
  off(event: "detach", listener: DetachListener): this;
  off(event: "message", listener: MessageListener): this;
}

export interface TabRef {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly tabId: BrowserTabId;
}

export interface OpenTabInput {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly url: string;
  readonly openedBy: BrowserTabOpener;
}

export interface CdpTabs {
  /** The session's tabs now, in tab order. */
  readonly sessionTabs: (hostKey: string, sessionId: SessionId) => ReadonlyArray<BrowserTab>;
  /**
   * Whether the session has any tab at all, targets or not: restored tabs whose partition
   * isn't routed yet count, so `Polaris.hello` doesn't open them a second time.
   */
  readonly hasTabs: (hostKey: string, sessionId: SessionId) => boolean;
  /** The tab's debugger, or null once the tab is gone. */
  readonly debuggeeOf: (tabId: BrowserTabId) => CdpDebuggee | null;
  /** Opens a tab in the session's Browser, in the background when it is not on screen. */
  readonly openTab: (input: OpenTabInput) => Promise<BrowserTab>;
  readonly closeTab: (tab: TabRef) => Promise<void>;
  readonly activateTab: (tab: TabRef) => Promise<void>;
  /** The Browser's navigation policy: false for a URL no tab may show. */
  readonly allowsUrl: (url: string) => boolean;
  /** The tab's indicator: the agent sent it a command that acts on it (`driving.ts`). */
  readonly setAgentDriving: (tabId: BrowserTabId, driving: boolean) => void;
  /** The session's tabs as they change: a `Snapshot` first, then each change. */
  readonly subscribe: (
    hostKey: string,
    sessionId: SessionId,
    listener: (event: BrowserTabEvent) => void
  ) => () => void;
}
