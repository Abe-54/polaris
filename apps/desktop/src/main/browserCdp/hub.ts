/**
 * One `webContents.debugger` per tab, shared by every facade on it (ENG-616): Electron allows
 * a single attachment, so the hub attaches on the first subscriber, fans events out, and
 * detaches after the last. DevTools can detach it; the hub reattaches while anyone is on it.
 */
import type { CdpJson } from "@polaris/protocol";
import type { CdpDebuggee, DetachListener, MessageListener } from "./ports.ts";

export interface HubSubscriber {
  readonly message: (method: string, params: CdpJson, sessionId: string) => void;
  /** The debugger is gone for good: the tab closed, or a reattach failed. */
  readonly detached: (reason: string) => void;
}

export interface DebuggerHub {
  /** Attaches when first used; the returned release detaches after the last. */
  readonly acquire: (subscriber: HubSubscriber) => () => void;
  readonly send: (method: string, params?: CdpJson, sessionId?: string) => Promise<CdpJson>;
  /** Subscribers now; the tab's "agent driving" indicator follows it. */
  readonly size: () => number;
}

const CDP_PROTOCOL_VERSION = "1.3";

const hubs = new WeakMap<CdpDebuggee, DebuggerHub>();

/**
 * Chromium drops synthetic input on a page that is not focused, and a background tab never
 * is: focus emulation makes an agent's clicks land there. Playwright does the same per page.
 */
const attach = (debuggee: CdpDebuggee) => {
  debuggee.attach(CDP_PROTOCOL_VERSION);
  void debuggee
    .sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true })
    .catch(() => undefined);
};

const makeHub = (debuggee: CdpDebuggee): DebuggerHub => {
  const subscribers = new Set<HubSubscriber>();

  const onMessage: MessageListener = (_event, method, params, sessionId) => {
    for (const subscriber of subscribers) subscriber.message(method, params, sessionId);
  };

  const onDetach: DetachListener = (_event, reason) => {
    if (subscribers.size === 0) return;

    try {
      attach(debuggee);
    } catch {
      const gone = [...subscribers];
      subscribers.clear();
      debuggee.off("message", onMessage);
      debuggee.off("detach", onDetach);
      gone.forEach((subscriber) => subscriber.detached(reason));
    }
  };

  return {
    acquire: (subscriber) => {
      if (subscribers.size === 0) {
        debuggee.on("message", onMessage);
        debuggee.on("detach", onDetach);

        if (!debuggee.isAttached()) attach(debuggee);
      }

      subscribers.add(subscriber);
      let released = false;

      return () => {
        if (released) return;
        released = true;
        subscribers.delete(subscriber);

        if (subscribers.size > 0) return;
        debuggee.off("message", onMessage);
        debuggee.off("detach", onDetach);

        if (debuggee.isAttached()) debuggee.detach();
      };
    },
    send: (method, params, sessionId) => debuggee.sendCommand(method, params, sessionId),
    size: () => subscribers.size,
  };
};

/** The hub for `debuggee`, made on first use. */
export const hubOf = (debuggee: CdpDebuggee): DebuggerHub => {
  const existing = hubs.get(debuggee);

  if (existing !== undefined) return existing;
  const hub = makeHub(debuggee);
  hubs.set(debuggee, hub);

  return hub;
};
