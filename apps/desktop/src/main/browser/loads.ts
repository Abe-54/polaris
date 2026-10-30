/**
 * Every load of a tab waits for its partition's setup (ADR 0093): until Host addresses are
 * routed to the Host, a page loaded here could reach this machine's loopback instead.
 */
import type { BrowserTabId } from "../../shared/browserContract.ts";
import { latestLoads } from "./order.ts";

export interface TabLoadsDeps {
  /** The tab's partition setup, retried by the caller after a failure. */
  readonly ready: (tabId: BrowserTabId) => Promise<void>;
  readonly open: (tabId: BrowserTabId, url: string) => void;
  /** The setup failed: the tab shows why, and nothing else loads. */
  readonly fail: (tabId: BrowserTabId, url: string, cause: unknown) => void;
}

/** A load of `url`, or a history step (`go`) on the page at `url`. */
interface Step {
  readonly url: string;
  readonly go: (() => void) | null;
}

export const tabLoads = ({ ready, open, fail }: TabLoadsDeps) => {
  const failed = new Map<BrowserTabId, string>();
  /** The URL of the tab's latest load or step still waiting for setup. */
  const waiting = new Map<BrowserTabId, string>();

  const failWith = (tabId: BrowserTabId, url: string, cause: unknown) => {
    failed.set(tabId, url);
    fail(tabId, url, cause);
  };

  const loads = latestLoads<BrowserTabId, Step>(
    (tabId, step) => {
      waiting.delete(tabId);

      if (step.go === null) open(tabId, step.url);
      else step.go();
    },
    (tabId, step, cause) => {
      waiting.delete(tabId);
      failWith(tabId, step.url, cause);
    }
  );

  const request = (tabId: BrowserTabId, step: Step) => {
    failed.delete(tabId);
    waiting.set(tabId, step.url);
    loads.request(tabId, step, ready(tabId));
  };

  return {
    /** Loads `url` once the partition is ready; a later load of the tab wins over this one. */
    load: (tabId: BrowserTabId, url: string) => request(tabId, { url, go: null }),
    /** Back, forward or reload on the page at `url`, also only once the partition is ready. */
    step: (tabId: BrowserTabId, url: string, go: () => void) => request(tabId, { url, go }),
    /** The URL whose load the setup failed, which a reload tries again; null otherwise. */
    failedUrl: (tabId: BrowserTabId) => failed.get(tabId) ?? null,
    /**
     * Routing was taken away: loads still waiting are dropped and the tab shows `cause`. A reload
     * retries the URL that was waiting, else `shown`, the page's own.
     */
    retire: (tabId: BrowserTabId, shown: string, cause: unknown) => {
      const url = waiting.get(tabId) ?? shown;

      loads.forget(tabId);
      waiting.delete(tabId);
      failWith(tabId, url, cause);
    },
    forget: (tabId: BrowserTabId) => {
      loads.forget(tabId);
      failed.delete(tabId);
      waiting.delete(tabId);
    },
  };
};

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Marks the failure page, so the tab keeps the URL it was asked for. */
export const SETUP_FAILED_PAGE = "data:text/html;charset=utf-8,%3C!--polaris-setup-failed--%3E";

/** The page a tab shows when its partition couldn't route Host addresses to the Host. */
export const setupFailedPage = (cause: unknown) =>
  SETUP_FAILED_PAGE +
  encodeURIComponent(
    [
      "<!doctype html><meta charset=utf-8><title>Can't reach this workspace's host</title>",
      "<style>:root{color-scheme:light dark;font:15px/1.5 system-ui;}",
      "body{max-width:36rem;margin:20vh auto;padding:0 24px;}",
      "code{font:12px ui-monospace,monospace;opacity:.7;}</style>",
      "<h1 style='font-size:18px;font-weight:500'>Can't reach this workspace's host</h1>",
      "<p>The browser couldn't route host addresses to this workspace's host, so it won't ",
      "load them from this Mac instead. Reload to try again.</p>",
      `<code>${escape(String(cause))}</code>`,
    ].join("")
  );
