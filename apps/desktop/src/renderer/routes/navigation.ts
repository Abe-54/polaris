/**
 * Navigation: the user's choices (mode, Host, Workspace, session, sidebar
 * view, pane) in a zustand store, persisted per window, plus the actions the
 * shell and features use to move around. `useSelection()` resolves them.
 */
import type { SessionId, WorkspaceId } from "@polaris/protocol";
import { Option, Schema } from "effect";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Route } from "../../shared/api.ts";
import type { AppState, AppStore } from "../store/store.ts";
import {
  initialNav,
  type NavState,
  recentKey,
  withRecent,
  type Selection,
  type SidebarView,
  resolveSelection,
  type SessionSort,
  type SettingsSection,
  workspaceKey,
} from "./selection.ts";
import { type BackForward, createPages, editPlaces, type Page } from "./history.ts";
import { reviewRoute } from "./review.ts";
import { timeSwitch } from "./switchTimer.ts";
import { barHosts, barWorkspaces, type BarHost, isRegistered, topBarMode } from "./topBar.ts";

export type NavStore = StoreApi<NavState>;

const keepsMode = (mode: Route): Route =>
  mode === "edit" || mode === "data" ? mode : "orchestrate";

const NO_OVERLAY = { jumpOpen: false, paletteOpen: false, helpOpen: false, folder: null } as const;

const STORAGE_KEY = "polaris.navigation.v1";

const Persisted = Schema.Struct({
  mode: Schema.Literals(["orchestrate", "review", "edit", "data"]),
  hostKey: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  sidebar: Schema.Literals(["sessions", "needs-you"]),
  topBar: Schema.Literals(["workspaces", "machines", "hidden"]),
  lastSession: Schema.Record(Schema.String, Schema.String),
  folded: Schema.Record(Schema.String, Schema.Boolean),
  recent: Schema.optionalKey(Schema.Array(Schema.String)),
  sessionSort: Schema.optionalKey(Schema.Literals(["active", "newest"])),
});

const decodePersisted = Schema.decodeUnknownOption(Schema.fromJsonString(Persisted));

/** The persisted navigation, or the defaults; storage can be missing or unreadable. */
export const loadNav = (storage: Pick<Storage, "getItem"> | null): NavState => {
  const raw = (() => {
    try {
      return storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  })();

  if (raw === null) return initialNav;

  return Option.match(decodePersisted(raw), {
    onNone: () => initialNav,
    // SAFETY: ids are opaque branded strings; a stale one resolves to the nearest that exists.
    onSome: (p) => ({ ...initialNav, ...(p as Partial<NavState>) }),
  });
};

const persistable = (nav: NavState) => ({
  mode: nav.mode,
  hostKey: nav.hostKey,
  workspaceId: nav.workspaceId,
  sessionId: nav.sessionId,
  sidebar: nav.sidebar,
  topBar: nav.topBar,
  lastSession: nav.lastSession,
  folded: nav.folded,
  recent: nav.recent,
  sessionSort: nav.sessionSort,
});

export interface SessionTarget {
  readonly hostKey: string;
  readonly sessionId: SessionId;
}

export interface WorkspaceTarget {
  readonly hostKey: string;
  readonly workspaceId: WorkspaceId;
}

export interface ShellActions {
  readonly setMode: (mode: Route) => void;
  readonly selectSession: (target: SessionTarget) => void;
  /** `inputAt` is the input event's timeStamp, to time the switch. */
  readonly selectWorkspace: (target: WorkspaceTarget, inputAt?: number) => void;
  readonly selectHost: (hostKey: string, inputAt?: number) => void;
  /** ⌃1…⌃0: a Workspace chip in the Workspace bar, a machine in the machine bar. */
  readonly selectShortcut: (index: number, inputAt?: number) => void;
  readonly showSidebar: (view: SidebarView) => void;
  readonly openJump: () => void;
  readonly setJumpOpen: (open: boolean) => void;
  /** The Command Palette (⇧⌘P), one of the shell's overlays. */
  readonly setPaletteOpen: (open: boolean) => void;
  readonly setHelpOpen: (open: boolean) => void;
  /** The ⌘O dialog, on `hostKey` (the selected Host when omitted). */
  readonly openFolder: (hostKey?: string | null) => void;
  readonly closeFolder: () => void;
  /** Closes the shell's overlay (jump menu, palette, shortcut help, ⌘O); true when one was open. */
  readonly closeOverlay: () => boolean;
  readonly startNewSession: () => void;
  /** New session on another Host or Workspace: its first Workspace, or its home, when none is given. */
  readonly startNewSessionIn: (hostKey: string, workspaceId?: WorkspaceId | null) => void;
  readonly closeNewSession: () => void;
  readonly toggleFolded: (key: string, open: boolean) => void;
  readonly setSessionSort: (sort: SessionSort) => void;
  /** Settings over the three zones (⌘,); the last section when none is given. */
  readonly openSettings: (
    section?: SettingsSection,
    options?: { readonly adding?: boolean }
  ) => void;
  /** Back to where the user was (esc). */
  readonly closeSettings: () => void;
  /** The page shown before this one (the mouse's back button, ⌘[); in Edit, the place. */
  readonly back: () => void;
  readonly forward: () => void;
  readonly canGoBack: () => boolean;
  readonly canGoForward: () => boolean;
}

export interface Navigation {
  readonly store: NavStore;
  readonly actions: ShellActions;
  /** The selection as it stands, resolved against the data. */
  readonly current: () => Selection;
}

const barOf = (app: AppState): ReadonlyArray<BarHost> =>
  barHosts({ hosts: app.hosts, models: app.hostModels });

const sameSelection = (a: Selection, b: Selection) =>
  a.mode === b.mode &&
  a.topBar === b.topBar &&
  a.hostKey === b.hostKey &&
  a.workspaceId === b.workspaceId &&
  a.sessionId === b.sessionId &&
  a.pane === b.pane &&
  a.sidebar === b.sidebar &&
  a.settings === b.settings;

export interface NavigationInput {
  readonly app: AppStore;
  readonly storage: Storage | null;
  /**
   * A new session with no Workspace on the Host asks for one (onboarding's home fallback);
   * null when none could be made, which the callee has already told the user.
   */
  readonly ensureWorkspace?: (hostKey: string) => Promise<WorkspaceId | null>;
}

export const createNavigation = ({
  app,
  storage,
  ensureWorkspace,
}: NavigationInput): Navigation => {
  const store = createStore<NavState>(() => loadNav(storage));
  const set = (patch: Partial<NavState>) => store.setState(patch);

  let lastSection: SettingsSection = "appearance";

  let cache: { nav: NavState; app: AppState; selection: Selection } | null = null;

  /** Stable between changes, so it can back `useSyncExternalStore`. */
  const current = () => {
    const state = app.getState();
    const nav = store.getState();

    if (
      cache !== null &&
      cache.nav === nav &&
      cache.app.hosts === state.hosts &&
      cache.app.hostModels === state.hostModels
    ) {
      return cache.selection;
    }

    const selection = resolveSelection({ nav, bar: barOf(state), models: state.hostModels });

    const unchanged = cache !== null && sameSelection(cache.selection, selection);

    cache = {
      nav,
      app: state,
      selection: unchanged && cache !== null ? cache.selection : selection,
    };

    return cache.selection;
  };

  /** Remembers the open session of the Workspace being left, so switching back restores it. */
  const remembered = () => {
    const { hostKey, workspaceId, sessionId } = current();
    const { lastSession } = store.getState();

    return hostKey === null || workspaceId === null || sessionId === null
      ? lastSession
      : { ...lastSession, [workspaceKey(hostKey, workspaceId)]: sessionId };
  };

  const selectWorkspace = ({ hostKey, workspaceId }: WorkspaceTarget, inputAt?: number) => {
    set({
      lastSession: remembered(),
      recent: withRecent(store.getState().recent, recentKey("workspace", hostKey, workspaceId)),
      hostKey,
      workspaceId,
      sessionId: null,
      pane: "session",
      // Edit and Data follow the Workspace: choosing another one keeps them open on it.
      mode: keepsMode(store.getState().mode),
      settings: null,
    });
    timeSwitch(inputAt);
  };

  const selectHost = (hostKey: string, inputAt?: number) => {
    set({
      lastSession: remembered(),
      hostKey,
      workspaceId: null,
      sessionId: null,
      pane: "session",
      settings: null,
    });
    timeSwitch(inputAt);
  };

  const startNewSessionIn = (hostKey: string, workspaceId: WorkspaceId | null = null) => {
    // A hidden Workspace counts: ⌘N in one open from the jump menu starts there.
    const shown = isRegistered(app.getState().hostModels, hostKey, workspaceId);

    set({
      pane: "new-session",
      mode: "orchestrate",
      settings: null,
      hostKey,
      workspaceId: shown ? workspaceId : null,
      sessionId: null,
      newSessionAsks: store.getState().newSessionAsks + 1,
    });

    if (shown || ensureWorkspace === undefined) return;

    // The stage shows the setup, busy, until the Host's Workspace (or its home) arrives.
    void ensureWorkspace(hostKey).then((id) => {
      const nav = store.getState();

      if (nav.pane !== "new-session" || nav.hostKey !== hostKey) return;

      set(id === null ? { pane: "session" } : { workspaceId: id, sessionId: null });
    });
  };

  const exists = (hostKey: string, sessionId: SessionId, archived: boolean) => {
    const entry = app.getState().hostModels[hostKey]?.sessions.get(sessionId);

    return entry !== undefined && (archived || entry.session.state !== "archived");
  };

  const live = (page: Page) => {
    if (page.kind === "session") return exists(page.hostKey, page.sessionId, false);
    const { subject } = page;

    // A session's Turns stay reviewable once it's archived.
    return subject?.kind !== "session" || exists(subject.hostKey, subject.sessionId, true);
  };

  const shown = (): Page | undefined => {
    const { hostKey, sessionId, pane, settings, mode } = current();

    if (settings !== null) return undefined;

    if (mode === "review") return { kind: "review", subject: reviewRoute.getState().subject };

    return mode === "orchestrate" && pane === "session" && hostKey !== null && sessionId !== null
      ? { kind: "session", hostKey, sessionId }
      : undefined;
  };

  const pages = createPages({
    shown,
    live,
    open: (page) => {
      if (page.kind === "session") {
        actions.selectSession(page);

        return;
      }

      reviewRoute.setState({ subject: page.subject });
      set({ mode: "review", settings: null });
    },
  });

  /** In Edit, Back and Forward move through the Editor's places instead. */
  const backForward = (): BackForward | null =>
    current().mode === "edit" ? editPlaces.current : pages;

  const actions: ShellActions = {
    setMode: (mode) => set({ mode, settings: null }),
    selectSession: ({ hostKey, sessionId }) => {
      const entry = app.getState().hostModels[hostKey]?.sessions.get(sessionId);

      set({
        recent: withRecent(store.getState().recent, recentKey("session", hostKey, sessionId)),
        hostKey,
        sessionId,
        workspaceId: entry?.session.workspaceId ?? store.getState().workspaceId,
        pane: "session",
        mode: "orchestrate",
        settings: null,
      });
    },
    selectWorkspace,
    selectHost,
    selectShortcut: (index, inputAt) => {
      const bar = barOf(app.getState());

      if (store.getState().topBar === "workspaces") {
        const target = barWorkspaces(bar)[index];

        if (target !== undefined) {
          selectWorkspace({ hostKey: target.hostKey, workspaceId: target.workspace.id }, inputAt);
        }

        return;
      }

      const host = bar[index];

      if (host !== undefined) selectHost(host.host.key, inputAt);
    },
    showSidebar: (sidebar) => set({ sidebar }),
    // One shell overlay at a time: opening one closes the others.
    openJump: () => set({ ...NO_OVERLAY, jumpOpen: true }),
    setJumpOpen: (jumpOpen) => set(jumpOpen ? { ...NO_OVERLAY, jumpOpen } : { jumpOpen }),
    setPaletteOpen: (paletteOpen) =>
      set(paletteOpen ? { ...NO_OVERLAY, paletteOpen } : { paletteOpen }),
    setHelpOpen: (helpOpen) => set(helpOpen ? { ...NO_OVERLAY, helpOpen } : { helpOpen }),
    openFolder: (hostKey = null) => set({ ...NO_OVERLAY, folder: { hostKey } }),
    closeFolder: () => set({ folder: null }),
    closeOverlay: () => {
      const { jumpOpen, paletteOpen, helpOpen, folder } = store.getState();

      if (!jumpOpen && !paletteOpen && !helpOpen && folder === null) return false;
      set(NO_OVERLAY);

      return true;
    },
    startNewSession: () => {
      const { hostKey, workspaceId } = current();

      if (hostKey === null) set({ pane: "new-session", mode: "orchestrate", settings: null });
      else startNewSessionIn(hostKey, workspaceId);
    },
    startNewSessionIn,
    closeNewSession: () => set({ pane: "session" }),
    toggleFolded: (key, open) => set({ folded: { ...store.getState().folded, [key]: !open } }),
    setSessionSort: (sessionSort) => set({ sessionSort }),
    openSettings: (section, options) => {
      lastSection = section ?? lastSection;
      set({
        settings: { section: lastSection, adding: options?.adding ?? false },
        jumpOpen: false,
        paletteOpen: false,
      });
    },
    closeSettings: () => set({ settings: null }),
    back: () => backForward()?.back(),
    forward: () => backForward()?.forward(),
    canGoBack: () => backForward()?.canGoBack() ?? false,
    canGoForward: () => backForward()?.canGoForward() ?? false,
  };

  // The bar's mode follows the Workspace count, with hysteresis (topBar.ts).
  const updateTopBar = (state: AppState) => {
    const bar = barOf(state);
    const previous = store.getState().topBar;

    const next = topBarMode({
      workspaces: barWorkspaces(bar).length,
      hosts: bar.length,
      previous,
    });

    if (next !== previous && state.hosts.length > 0) set({ topBar: next });
  };

  app.subscribe((state, prev) => {
    if (state.hosts !== prev.hosts || state.hostModels !== prev.hostModels) {
      updateTopBar(state);
      // A session chosen before it arrived is shown once it does.
      pages.record();
    }
  });

  store.subscribe(pages.record);
  reviewRoute.subscribe(pages.record);

  let timer: ReturnType<typeof setTimeout> | null = null;

  store.subscribe(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;

      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(persistable(store.getState())));
      } catch {
        // Storage can be unavailable; navigation then lasts for this session only.
      }
    }, 300);
  });

  return { store, actions, current };
};
