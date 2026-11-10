/**
 * A link in the conversation to a Host address (`http://localhost:5173/…`, a loopback IP) opens
 * in the session's Browser (ENG-761), which reaches the Host's own loopback, not this machine's.
 */
import { isHostAddress, type SessionId, type WorkspaceId } from "@polaris/protocol";
import { polaris } from "../bridge.ts";

export interface BrowserLinkTarget {
  readonly hostKey: string;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
}

const parse = (href: string): URL | null => {
  try {
    return new URL(href);
  } catch {
    return null;
  }
};

/** The URL a link opens in the Browser: http(s) to a Host address; null for any other link. */
export const browserLinkOf = (href: string | null | undefined): string | null => {
  const url = href === null || href === undefined ? null : parse(href);

  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return null;

  return isHostAddress(url.hostname) ? url.href : null;
};

/** Opens `url` in a new tab of the session's Browser; `show` brings the Browser forward once it has. */
export const openBrowserLink = async (
  target: BrowserLinkTarget,
  url: string,
  show: () => void
): Promise<boolean> => {
  const result = await polaris().request("browser.openTab", { ...target, url });

  if (result.ok) show();

  return result.ok;
};
