/**
 * `Browsers` (`../browser`) behind the `CdpTabs` port (ENG-616): the registry stays the one
 * owner of tabs; the facade sees a session's tabs and each tab's `webContents.debugger`.
 */
import { allowedUrl, type Browsers } from "../browser/index.ts";
import { routedTabs } from "./gate.ts";
import type { CdpTabs } from "./ports.ts";

/** `browsers` is read on each call: main creates the registry after the Client runtime. */
const allTabsOf = (browsers: () => Browsers | null): CdpTabs => {
  const ready = (): Browsers => {
    const current = browsers();

    if (current === null) throw new Error("The Browser is not ready yet");

    return current;
  };

  return {
    sessionTabs: (hostKey, sessionId) => browsers()?.sessionTabs(hostKey, sessionId).tabs ?? [],
    hasTabs: (hostKey, sessionId) =>
      (browsers()?.sessionTabs(hostKey, sessionId).tabs.length ?? 0) > 0,
    debuggeeOf: (tabId) => browsers()?.contentsOf(tabId)?.debugger ?? null,
    openTab: (input) => ready().openTab(input),
    closeTab: async ({ hostKey, sessionId, tabId }) => ready().closeTab(hostKey, sessionId, tabId),
    activateTab: async ({ hostKey, sessionId, tabId }) =>
      ready().activateTab(hostKey, sessionId, tabId),
    allowsUrl: allowedUrl,
    setAgentDriving: (tabId, driving) => browsers()?.setAgentDriving(tabId, driving),
    subscribe: (hostKey, sessionId, listener) =>
      browsers()?.subscribe(hostKey, sessionId, listener) ?? (() => undefined),
  };
};

/** Only tabs whose partition is routed, so CDP can't load a Host address before it is. */
export const cdpTabsOf = (browsers: () => Browsers | null): CdpTabs =>
  routedTabs(allTabsOf(browsers), {
    isRouted: (tabId) => browsers()?.routing.isRouted(tabId) ?? false,
    whenRouted: async (tabId) => {
      const current = browsers();

      if (current === null) throw new Error("The Browser is not ready yet");

      return current.routing.whenRouted(tabId);
    },
    onChange: (listener) => browsers()?.routing.onChange(listener) ?? (() => undefined),
  });
