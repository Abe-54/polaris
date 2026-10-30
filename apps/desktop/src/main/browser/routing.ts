/**
 * Which tabs have their partition's Host-address routing in place (ADR 0093). Only a routed
 * tab may be driven over CDP: a page loaded before routing could reach this machine's loopback.
 */
import type { BrowserTabId } from "../../shared/browserContract.ts";

/** What the CDP gate reads: whether a tab is routed, and when that changes. */
export interface TabRoutingView {
  readonly isRouted: (tabId: BrowserTabId) => boolean;
  /** Resolves once the tab is routed; rejects when its setup fails or the tab closes first. */
  readonly whenRouted: (tabId: BrowserTabId) => Promise<void>;
  readonly onChange: (listener: (tabId: BrowserTabId, routed: boolean) => void) => () => void;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
}

export const tabRouting = () => {
  const routed = new Set<BrowserTabId>();
  /** Bumped by each setup and whenever a tab loses routing, so a superseded setup does nothing. */
  const epochs = new Map<BrowserTabId, number>();
  const epochOf = (tabId: BrowserTabId) => epochs.get(tabId) ?? 0;
  /** Why a tab's latest setup failed, until another begins, so a late `whenRouted` hears it. */
  const failed = new Map<BrowserTabId, unknown>();
  const waiters = new Map<BrowserTabId, Array<Waiter>>();
  const listeners = new Set<(tabId: BrowserTabId, routed: boolean) => void>();

  const settle = (tabId: BrowserTabId, settled: (waiter: Waiter) => void) => {
    const waiting = waiters.get(tabId) ?? [];

    waiters.delete(tabId);
    waiting.forEach(settled);
  };

  const set = (tabId: BrowserTabId, now: boolean) => {
    if (routed.has(tabId) === now) return;

    if (now) routed.add(tabId);
    else routed.delete(tabId);

    for (const listener of listeners) listener(tabId, now);
  };

  const unroute = (tabId: BrowserTabId, cause: unknown) => {
    failed.set(tabId, cause);
    set(tabId, false);
    settle(tabId, (waiter) => waiter.reject(cause));
  };

  const view: TabRoutingView = {
    isRouted: (tabId) => routed.has(tabId),
    whenRouted: (tabId) => {
      if (routed.has(tabId)) return Promise.resolve();

      if (failed.has(tabId)) return Promise.reject(failed.get(tabId));

      return new Promise((resolve, reject) =>
        waiters.set(tabId, [...(waiters.get(tabId) ?? []), { resolve, reject }])
      );
    },
    onChange: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };

  return {
    view,
    /** A setup begins: its own epoch, which `routed` and `failed` honour only while current. */
    begin: (tabId: BrowserTabId) => {
      const epoch = epochOf(tabId) + 1;

      epochs.set(tabId, epoch);
      failed.delete(tabId);

      return epoch;
    },
    /** The tab's setup, begun at `epoch`, succeeded; false when routing was lost since. */
    routed: (tabId: BrowserTabId, epoch: number) => {
      if (epoch !== epochOf(tabId)) return false;
      set(tabId, true);
      settle(tabId, (waiter) => waiter.resolve());

      return true;
    },
    /** The Host's routing was retired: the tab is unrouted, and setups begun before can't route it. */
    unrouted: (tabId: BrowserTabId, cause: unknown) => {
      epochs.set(tabId, epochOf(tabId) + 1);
      unroute(tabId, cause);
    },
    /** The setup begun at `epoch` failed; ignored once a newer setup or a retirement superseded it. */
    failed: (tabId: BrowserTabId, epoch: number, cause: unknown) => {
      if (epoch === epochOf(tabId)) unroute(tabId, cause);
    },
    forget: (tabId: BrowserTabId) => {
      epochs.set(tabId, epochOf(tabId) + 1);
      failed.delete(tabId);
      routed.delete(tabId);
      settle(tabId, (waiter) => waiter.reject(new Error("the tab closed")));
    },
  };
};
