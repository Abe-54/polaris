/**
 * Which of an agent's tab commands count as driving the tab. Attaching and the setup a CDP
 * client sends to every tab it attaches (enabling domains, frame trees, bindings, emulation)
 * don't: agent-browser auto-attaches to the person's own new tabs too.
 */

/** Setup commands outside the `Target.*`, `*.enable`, `*.disable` and `Emulation.*` rules. */
const SETUP = new Set([
  "Runtime.runIfWaitingForDebugger",
  "Runtime.addBinding",
  "Page.getFrameTree",
  "Page.setLifecycleEventsEnabled",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.createIsolatedWorld",
  "Page.setInterceptFileChooserDialog",
  "Page.setBypassCSP",
  "Page.setDownloadBehavior",
  "Network.setExtraHTTPHeaders",
  "Network.setCacheDisabled",
  "Network.setBypassServiceWorker",
  "Network.setUserAgentOverride",
  "Security.setIgnoreCertificateErrors",
  "Fetch.continueRequest",
]);

const PASSIVE_DOMAINS = new Set(["Target", "Emulation", "Log", "Inspector"]);

/** True when `method` acts on the tab (navigates, reads, clicks, types…), not just sets it up. */
export const drives = (method: string): boolean => {
  const [domain = "", name = ""] = method.split(".");

  if (PASSIVE_DOMAINS.has(domain) || name === "enable" || name === "disable") return false;

  return !SETUP.has(method);
};
