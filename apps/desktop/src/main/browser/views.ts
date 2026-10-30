/**
 * The Electron side of Browser tabs: one sandboxed WebContentsView per tab in its Workspace's
 * persistent partition, laid over the window where the renderer's Browser area is. Every
 * navigation, redirect and popup passes `allowedUrl`; a popup becomes a tab in the same session.
 */
import type { WorkspaceId } from "@polaris/protocol";
import { type BrowserWindow, session, type WebContents, WebContentsView } from "electron";
import type { BrowserTab, BrowserTabId } from "../../shared/browserContract.ts";
import { SETUP_FAILED_PAGE, setupFailedPage, tabLoads } from "./loads.ts";
import { tabRouting } from "./routing.ts";
import { allowedFrameUrl, allowedUrl, isHostAddress } from "./navigation.ts";
import { distrustInSession } from "../tls/distrust.ts";
import { cancelPickIn, pickIn } from "./pick/index.ts";
import type { TabChange, ViewHost } from "./registry.ts";

/** The Workspace's partition: its logins and cookies, shared by its sessions' Browsers. */
export const browserPartition = (hostKey: string, workspaceId: string) =>
  `persist:polaris-browser-${hostKey}-${workspaceId}`;

export interface ViewsDeps {
  /** The window the Browser shows in. */
  readonly window: () => BrowserWindow | null;
  /**
   * Sets up a partition (Host addresses through the Host); every load waits on it. Shares a
   * setup in flight or done, and retries one that failed.
   */
  readonly configureSession: (
    hostKey: string,
    workspaceId: WorkspaceId,
    partition: Electron.Session
  ) => Promise<void>;
  readonly onChange: (tabId: BrowserTabId, change: Partial<TabChange>) => void;
  /** The page asked for a new window at an allowed URL. */
  readonly onPopup: (from: BrowserTabId, url: string) => void;
}

const history = (contents: WebContents) => ({
  canGoBack: contents.navigationHistory.canGoBack(),
  canGoForward: contents.navigationHistory.canGoForward(),
});

/** Keeps the tab's model in step with its page, and its page inside the navigation policy. */
const follow = (tabId: BrowserTabId, contents: WebContents, deps: ViewsDeps) => {
  const navigated = (url: string) => {
    if (!url.startsWith(SETUP_FAILED_PAGE))
      deps.onChange(tabId, { url, hostAddress: isHostAddress(url), ...history(contents) });
  };

  contents.on("did-start-loading", () => deps.onChange(tabId, { loading: true }));
  contents.on("did-stop-loading", () =>
    deps.onChange(tabId, { loading: false, ...history(contents) })
  );
  contents.on("did-navigate", (_event, url) => navigated(url));
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) navigated(url);
  });
  contents.on("page-title-updated", (_event, title) => deps.onChange(tabId, { title }));
  contents.on("will-navigate", (event) => {
    if (!allowedUrl(event.url)) event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    if (!allowedUrl(event.url)) event.preventDefault();
  });
  // Iframes too, so a data: or blob: frame can't slip past the policy.
  contents.on("will-frame-navigate", (event) => {
    if (!allowedFrameUrl(event.url, event.isMainFrame)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (allowedUrl(url)) deps.onPopup(tabId, url);

    return { action: "deny" };
  });
};

export const electronViews = (deps: ViewsDeps) => {
  const views = new Map<BrowserTabId, WebContentsView>();
  /** Tabs in pick mode, and how to end it. */
  const picking = new Map<BrowserTabId, () => void>();
  const places = new Map<BrowserTabId, { hostKey: string; workspaceId: WorkspaceId }>();
  const prepared = new Set<string>();
  const routing = tabRouting();

  const partitionOf = (hostKey: string, workspaceId: WorkspaceId) => {
    const name = browserPartition(hostKey, workspaceId);
    const partition = session.fromPartition(name);

    if (!prepared.has(name)) {
      // Pages get no permissions (camera, notifications, devices…) and the app's TLS distrust list.
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
      partition.setDevicePermissionHandler(() => false);
      distrustInSession(partition);
      prepared.add(name);
    }

    return partition;
  };

  const onWindow = (view: WebContentsView) => {
    const win = deps.window();

    if (win !== null && !win.isDestroyed()) win.contentView.addChildView(view);
  };

  const withView = (tabId: BrowserTabId, use: (view: WebContentsView) => void) => {
    const view = views.get(tabId);

    if (view !== undefined && !view.webContents.isDestroyed()) use(view);
  };

  const setUp = async (tabId: BrowserTabId) => {
    const place = places.get(tabId);

    if (place === undefined) throw new Error("the tab is closed");

    return deps.configureSession(
      place.hostKey,
      place.workspaceId,
      partitionOf(place.hostKey, place.workspaceId)
    );
  };

  const loads = tabLoads({
    ready: (tabId) => {
      const epoch = routing.begin(tabId);

      return setUp(tabId).then(
        () => {
          // retireHost or destroy ran while this setup was in flight.
          if (!routing.routed(tabId, epoch)) throw new Error("the tab's routing was retired");
        },
        (cause: unknown) => {
          routing.failed(tabId, epoch, cause);
          throw cause;
        }
      );
    },
    open: (tabId, url) =>
      withView(tabId, (view) => void view.webContents.loadURL(url).catch(() => {})),
    fail: (tabId, url, cause) => {
      console.warn("[browser] partition setup failed", places.get(tabId), cause);
      deps.onChange(tabId, { url, hostAddress: isHostAddress(url), loading: false });
      withView(
        tabId,
        (view) => void view.webContents.loadURL(setupFailedPage(cause)).catch(() => {})
      );
    },
  });

  const load = (tabId: BrowserTabId, url: string) => {
    if (allowedUrl(url)) loads.load(tabId, url);
  };

  /** A history step, once the partition is ready like any load. */
  const step = (tabId: BrowserTabId, go: (view: WebContentsView) => void) =>
    withView(tabId, (view) =>
      loads.step(tabId, view.webContents.getURL(), () => withView(tabId, go))
    );

  /**
   * A removed Host: its tabs stop, lose CDP, and show why; a reload sets them up again. Runs
   * before the Host's proxy stops, so no page still points at a port another process can take.
   */
  const retireHost = (hostKey: string) => {
    for (const [tabId, place] of places) {
      if (place.hostKey !== hostKey) continue;
      const cause = new Error(`${hostKey} was removed`);

      routing.unrouted(tabId, cause);
      withView(tabId, (view) => {
        view.webContents.stop();
        loads.retire(tabId, view.webContents.getURL(), cause);
      });
    }
  };

  const endPick = (tabId: BrowserTabId) => picking.get(tabId)?.();

  const pick = async (tabId: BrowserTabId) => {
    const contents = views.get(tabId)?.webContents;

    if (contents === undefined || contents.isDestroyed()) return null;
    endPick(tabId);

    let end = () => {};

    const aborted = new Promise<void>((resolve) => (end = resolve));

    picking.set(tabId, end);

    try {
      return await pickIn(contents, aborted);
    } finally {
      if (picking.get(tabId) === end) picking.delete(tabId);
    }
  };

  const host: ViewHost = {
    create: (tab: BrowserTab, place) => {
      const partition = partitionOf(place.hostKey, place.workspaceId);

      const view = new WebContentsView({
        webPreferences: {
          session: partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          spellcheck: false,
        },
      });

      view.setVisible(false);
      views.set(tab.tabId, view);
      follow(tab.tabId, view.webContents, deps);
      onWindow(view);
      places.set(tab.tabId, place);
      load(tab.tabId, tab.url);
    },
    load,
    back: (tabId) =>
      step(tabId, (view) => {
        if (view.webContents.navigationHistory.canGoBack())
          view.webContents.navigationHistory.goBack();
      }),
    forward: (tabId) =>
      step(tabId, (view) => {
        if (view.webContents.navigationHistory.canGoForward())
          view.webContents.navigationHistory.goForward();
      }),
    reload: (tabId, ignoreCache) => {
      const failed = loads.failedUrl(tabId);

      if (failed !== null) return load(tabId, failed);
      step(tabId, (view) =>
        ignoreCache ? view.webContents.reloadIgnoringCache() : view.webContents.reload()
      );
    },
    devtools: (tabId, open) =>
      withView(tabId, (view) =>
        open ? view.webContents.openDevTools({ mode: "detach" }) : view.webContents.closeDevTools()
      ),
    pick,
    cancelPick: (tabId) => {
      endPick(tabId);
      withView(tabId, (view) => cancelPickIn(view.webContents));
    },
    show: (tabId, bounds) => {
      for (const [id, view] of views) {
        if (id === tabId) continue;

        view.setVisible(false);
        endPick(id);
      }

      withView(tabId, (view) => {
        // Re-adding raises it above anything added since.
        onWindow(view);
        view.setBounds(bounds);
        view.setVisible(bounds.width > 0 && bounds.height > 0);
      });
    },
    hideAll: () => {
      for (const view of views.values()) view.setVisible(false);

      for (const end of picking.values()) end();
    },
    destroy: (tabId) => {
      endPick(tabId);

      withView(tabId, (view) => {
        view.setVisible(false);
        deps.window()?.contentView.removeChildView(view);
        view.webContents.close();
      });
      views.delete(tabId);
      places.delete(tabId);
      loads.forget(tabId);
      routing.forget(tabId);
    },
  };

  return {
    host,
    retireHost,
    /** Which tabs are routed: the CDP facade sees only those (`browserCdp/gate.ts`). */
    routing: routing.view,
    /** The tab's page, for CDP (ENG-617); null until its partition is routed. */
    contentsOf: (tabId: BrowserTabId): WebContents | null => {
      if (!routing.view.isRouted(tabId)) return null;
      const contents = views.get(tabId)?.webContents;

      return contents === undefined || contents.isDestroyed() ? null : contents;
    },
  };
};
