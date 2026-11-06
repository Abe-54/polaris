/**
 * The single main window: the platform's title bar (chrome.ts), hardened web preferences,
 * and no navigation away from the app.
 */
import { BrowserWindow, nativeTheme, type Rectangle, screen, shell } from "electron";
import type { Option } from "effect";
import { clientPlatform, PLATFORM_ARG } from "../shared/platform.ts";
import { FRAME_WEB_PREFERENCES, subframeMayLoad } from "./frames.ts";
import { chromeOptions, menuKeys, titleBarOverlay, WM_ENTERMENULOOP } from "./chrome.ts";
import { popupAppMenu } from "./menu.ts";
import { externalWindowOpenHandler } from "./externalLinks.ts";
import { placeWindow, type Placement, type WindowState } from "./windowPlacement.ts";

export interface MainWindowInput {
  readonly url: string;
  readonly preload: string;
  readonly trusted: (url: string) => boolean;
  /** Smoke tests and benchmarks keep the window hidden. */
  readonly show: boolean;
  /** Linux's window list and dock take the icon from the window; macOS uses the bundle's. */
  readonly icon: string | null;
  /** The window's state from the last run, if settings held a valid one. */
  readonly savedState: Option.Option<WindowState>;
  readonly saveState: (state: WindowState) => void;
}

const DEFAULT_SIZE = { width: 1440, height: 900 };

const MIN_SIZE = { width: 760, height: 480 };

const SAVE_DELAY_MS = 500;

const currentPlacement = (saved: Option.Option<WindowState>): Placement =>
  placeWindow({
    saved,
    displays: screen.getAllDisplays(),
    primary: screen.getPrimaryDisplay(),
    defaults: DEFAULT_SIZE,
    min: MIN_SIZE,
  });

const wholePixels = (rect: Rectangle): Rectangle => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
});

/** Saves on every change (moves and resizes debounced) and on close. */
const trackState = (win: BrowserWindow, initial: Placement, save: (s: WindowState) => void) => {
  let normal = initial.bounds;

  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);

    timer = null;
  };

  const flush = () => {
    cancel();

    if (win.isDestroyed()) return;

    const fullScreen = win.isFullScreen();

    // Full screen reports the screen's bounds; keep the last normal ones instead.
    if (!fullScreen) normal = wholePixels(win.getNormalBounds());

    save({
      bounds: normal,
      displayId: screen.getDisplayMatching(normal).id,
      maximized: win.isMaximized(),
      fullScreen,
    });
  };

  const later = () => {
    cancel();
    timer = setTimeout(flush, SAVE_DELAY_MS);
  };

  win.on("resize", later);
  win.on("move", later);
  win.on("maximize", flush);
  win.on("unmaximize", flush);
  win.on("enter-full-screen", flush);
  win.on("leave-full-screen", flush);
  win.on("close", flush);
};

/** DESIGN.md `bg-dark` / `bg-light`, so the first frame matches the theme. */
export const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#1A1B1D" : "#FBFBFC");

export const createMainWindow = (input: MainWindowInput) => {
  const { url, preload, trusted, show, icon } = input;
  const platform = clientPlatform();
  const placement = currentPlacement(input.savedState);

  const win = new BrowserWindow({
    ...placement.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: "Polaris",
    backgroundColor: windowBackground(),
    ...chromeOptions(platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload,
      ...FRAME_WEB_PREFERENCES,
      spellcheck: false,
      v8CacheOptions: "bypassHeatCheck",
      additionalArguments: [`${PLATFORM_ARG}${platform}`],
    },
  });

  if (platform === "linux" && icon !== null) win.setIcon(icon);

  if (platform === "win32") {
    const keys = menuKeys();

    // The menu bar stays hidden; F10 or a lone Alt drops the menu from the lockup instead.
    win.setMenuBarVisibility(false);
    win.webContents.on("before-input-event", (event, input) => {
      if (!keys.opens(input)) return;
      event.preventDefault();
      popupAppMenu(win);
    });
    win.on("blur", keys.reset);
    win.hookWindowMessage(WM_ENTERMENULOOP, keys.reset);
  }

  // A Visualization frame's sandbox has no `allow-popups`, so it never reaches this.
  win.webContents.setWindowOpenHandler(externalWindowOpenHandler((url) => shell.openExternal(url)));
  win.webContents.on("will-navigate", (event, target) => {
    if (!trusted(target)) event.preventDefault();
  });
  // The preload disables WebRTC in every realm; this policy additionally blocks direct UDP.
  win.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  // `will-navigate` sees the main frame only; a Visualization frame never leaves its document.
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !subframeMayLoad(event.url)) event.preventDefault();
  });
  // Appearance changes set themeSource, which lands here: the overlay follows the bar.
  nativeTheme.on("updated", () => {
    if (win.isDestroyed()) return;
    win.setBackgroundColor(windowBackground());

    if (platform === "win32") {
      win.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors));
    }
  });

  // Smoke runs and benchmarks stay hidden, and leave the saved state alone.
  if (show) {
    win.once("ready-to-show", () => {
      // maximize() shows a hidden window itself, so it waits for the first paint too.
      if (placement.maximized) win.maximize();

      win.show();

      if (placement.fullScreen) win.setFullScreen(true);

      trackState(win, placement, input.saveState);
    });
  }

  void win.loadURL(url);

  return win;
};
