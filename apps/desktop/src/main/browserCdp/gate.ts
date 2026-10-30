/**
 * The facade sees only tabs whose partition routes Host addresses to the Host (ADR 0093): a
 * tab still setting up, or whose setup failed or was retired, isn't a target at all.
 */
import { Match } from "effect";
import { BrowserTabEvent } from "../../shared/browserContract.ts";
import type { TabRoutingView } from "../browser/routing.ts";
import type { CdpTabs } from "./ports.ts";

export const routedTabs = (tabs: CdpTabs, routing: TabRoutingView): CdpTabs => ({
  ...tabs,
  sessionTabs: (hostKey, sessionId) =>
    tabs.sessionTabs(hostKey, sessionId).filter((tab) => routing.isRouted(tab.tabId)),
  debuggeeOf: (tabId) => (routing.isRouted(tabId) ? tabs.debuggeeOf(tabId) : null),
  openTab: async (input) => {
    const tab = await tabs.openTab(input);

    try {
      await routing.whenRouted(tab.tabId);
    } catch (cause) {
      // An agent's tab that can't be routed goes, so retries don't pile up failed tabs.
      const ref = { hostKey: input.hostKey, sessionId: input.sessionId, tabId: tab.tabId };

      await tabs.closeTab(ref).catch(() => undefined);
      throw cause;
    }

    return tab;
  },
  subscribe: (hostKey, sessionId, listener) => {
    const unsubscribe = tabs.subscribe(hostKey, sessionId, (event) => {
      const routedEvent = Match.valueTags(event, {
        Snapshot: ({ tabs: now, activeTabId }): BrowserTabEvent | null =>
          BrowserTabEvent.cases.Snapshot.make({
            tabs: now.filter((tab) => routing.isRouted(tab.tabId)),
            activeTabId,
          }),
        Opened: (opened): BrowserTabEvent | null =>
          routing.isRouted(opened.tab.tabId) ? opened : null,
        Changed: (changed): BrowserTabEvent | null =>
          routing.isRouted(changed.tabId) ? changed : null,
        Activated: (activated): BrowserTabEvent | null => activated,
        Closed: (closed): BrowserTabEvent | null => closed,
      });

      if (routedEvent !== null) listener(routedEvent);
    });

    // A tab routed later appears with its fields as they are now; one unrouted closes.
    const offRouting = routing.onChange((tabId, routed) => {
      const tab = tabs.sessionTabs(hostKey, sessionId).find((each) => each.tabId === tabId);

      if (tab === undefined) return;
      listener(
        routed
          ? BrowserTabEvent.cases.Opened.make({ tab, byAgent: false })
          : BrowserTabEvent.cases.Closed.make({ tabId })
      );
    });

    return () => {
      unsubscribe();
      offRouting();
    };
  },
});
