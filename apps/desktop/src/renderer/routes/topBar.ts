/**
 * The adaptive top bar (ENG-177): every Workspace on every Host as a chip
 * while there are at most 10, the machine bar from 11, and nothing at all in
 * machine mode with a single Host. Pure, so it is unit-tested.
 */
import type { AgentSession, SessionState, Workspace, WorkspaceId } from "@polaris/protocol";
import type { HostView } from "../../shared/api.ts";
import { acceleratorLabel, currentKeyPlatform, type KeyPlatform } from "../../shared/chord.ts";
import { digitChord } from "../../shared/keymap.ts";
import type { HostModel, SessionEntry } from "../store/hostModel.ts";

export type TopBarMode = "workspaces" | "machines" | "hidden";

/** The machine bar takes over at this many Workspaces… */
export const MACHINE_BAR_AT = 11;

/** …and gives way again only at this many, so the bar never flips at 10/11. */
export const WORKSPACE_BAR_AT = 9;

export interface TopBarInput {
  readonly workspaces: number;
  readonly hosts: number;
  /** The bar's mode before this change; decides the band between the thresholds. */
  readonly previous: TopBarMode;
}

export const topBarMode = ({ workspaces, hosts, previous }: TopBarInput): TopBarMode => {
  const machines =
    workspaces >= MACHINE_BAR_AT || (previous !== "workspaces" && workspaces > WORKSPACE_BAR_AT);

  if (!machines) return "workspaces";

  return hosts <= 1 ? "hidden" : "machines";
};

/** Session States in the order a Workspace chip shows them: the loudest wins. */
const STATE_PRIORITY: ReadonlyArray<SessionState> = [
  "needs-you",
  "failed",
  "working",
  "starting",
  "limited",
  "in-terminal",
  "idle",
  "dormant",
];

export interface Summary {
  /** The state a chip or machine tab shows; null when nothing is active there. */
  readonly state: SessionState | null;
  /** The Harness of the session that decided `state` (for the dither's hue). */
  readonly harness: AgentSession["harness"] | null;
  readonly needsYou: number;
  readonly sessions: number;
}

export const needsYou = (entry: SessionEntry) =>
  entry.session.state === "needs-you" || entry.pendingApprovals.length > 0;

/** Sessions that count as active: everything but Archived. */
export const activeSessions = (model: HostModel, workspaceId?: WorkspaceId) =>
  [...model.sessions.values()].filter(
    (e) =>
      e.session.state !== "archived" &&
      (workspaceId === undefined || e.session.workspaceId === workspaceId)
  );

/** A session's state as the chrome shows it: a pending approval counts as Needs You. */
export const shownState = (entry: SessionEntry): SessionState =>
  needsYou(entry) ? "needs-you" : entry.session.state;

/**
 * What a chip or machine tab shows. `quiet` sessions (dismissed from Needs You on this Mac)
 * count as Idle (waiting on nobody here), not as Needs You.
 */
export const summarize = (
  entries: ReadonlyArray<SessionEntry>,
  quiet: (entry: SessionEntry) => boolean = () => false
): Summary => {
  let best: SessionEntry | null = null;
  const loud = (entry: SessionEntry) => needsYou(entry) && !quiet(entry);

  const state = (entry: SessionEntry): SessionState => {
    if (loud(entry)) return "needs-you";

    return entry.session.state === "needs-you" ? "idle" : entry.session.state;
  };

  const rank = (entry: SessionEntry) => STATE_PRIORITY.indexOf(state(entry));

  for (const entry of entries) {
    if (best === null || rank(entry) < rank(best)) best = entry;
  }

  return {
    state: best === null ? null : state(best),
    harness: best?.session.harness ?? null,
    needsYou: entries.filter(loud).length,
    sessions: entries.length,
  };
};

/** Workspaces the user keeps shown (CONTEXT.md: hidden until shown again), oldest first. */
export const shownWorkspaces = (model: HostModel): ReadonlyArray<Workspace> =>
  sortWorkspaces([...model.workspaces.values()].filter((w) => !w.hidden));

/** Workspaces the user hid from the top bar, oldest first: what "Show" offers. */
export const hiddenWorkspaces = (model: HostModel): ReadonlyArray<Workspace> =>
  sortWorkspaces([...model.workspaces.values()].filter((w) => w.hidden));

const sortWorkspaces = (list: ReadonlyArray<Workspace>) =>
  list.toSorted(
    (a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.name.localeCompare(b.name)
  );

export interface BarWorkspace {
  readonly hostKey: string;
  readonly workspace: Workspace;
  readonly summary: Summary;
  /**
   * Hidden by the user but listed for now: it is open, or a session in it needs you.
   * It has no ⌃N and doesn't count towards the machine bar (docs/adr/0037).
   */
  readonly hidden: boolean;
}

export interface BarHost {
  readonly host: HostView;
  readonly workspaces: ReadonlyArray<BarWorkspace>;
  readonly summary: Summary;
  /** Collapsed in the Workspace bar on this Mac: its chips are folded away and take no ⌃N. */
  readonly collapsed: boolean;
}

/** The Workspace in view, which stays listed even while hidden. */
export interface OpenWorkspace {
  readonly hostKey: string | null;
  readonly workspaceId: WorkspaceId | null;
}

export interface BarInput {
  readonly hosts: ReadonlyArray<HostView>;
  readonly models: Readonly<Record<string, HostModel>>;
  /** Sessions dismissed from Needs You on this Mac (`hostKey\u0000sessionId`): not counted. */
  readonly quiet?: ReadonlySet<string>;
  readonly open?: OpenWorkspace;
  /** Hosts collapsed in the Workspace bar on this Mac. */
  readonly collapsed?: ReadonlyArray<string>;
}

/** The local Host's key (main/hosts.ts `LOCAL_HOST_KEY`). */
export const LOCAL_HOST = "local";

/** Remote Hosts first in settings order, this Mac last (Paper 11U-0, MX-0), so ⌃N match. */
const barOrder = (hosts: ReadonlyArray<HostView>) => [
  ...hosts.filter((h) => h.key !== LOCAL_HOST),
  ...hosts.filter((h) => h.key === LOCAL_HOST),
];

export interface ListedInput {
  readonly hostKey: string;
  readonly model: HostModel;
  readonly open?: OpenWorkspace | undefined;
  readonly isQuiet?: (entry: SessionEntry) => boolean;
}

/**
 * A Host's Workspaces as the bar and the machine sidebar list them: the shown ones, then
 * any hidden one that is open or has a session that needs you, which never goes unseen.
 */
export const listedWorkspaces = ({
  hostKey,
  model,
  open,
  isQuiet,
}: ListedInput): ReadonlyArray<BarWorkspace> => {
  const item = (workspace: Workspace): BarWorkspace => ({
    hostKey,
    workspace,
    summary: summarize(activeSessions(model, workspace.id), isQuiet),
    hidden: workspace.hidden,
  });

  const isOpen = (w: Workspace) => open?.hostKey === hostKey && open.workspaceId === w.id;

  const peeking = hiddenWorkspaces(model)
    .map(item)
    .filter((w) => isOpen(w.workspace) || w.summary.needsYou > 0);

  return [...shownWorkspaces(model).map(item), ...peeking];
};

/** Every Host with its listed Workspaces; the source of both bars. */
export const barHosts = ({
  hosts,
  models,
  quiet,
  open,
  collapsed = [],
}: BarInput): ReadonlyArray<BarHost> =>
  barOrder(hosts).map((host) => {
    const model = models[host.key];

    const isQuiet = (entry: SessionEntry) =>
      quiet?.has(`${host.key}\u0000${entry.session.id}`) ?? false;

    return {
      host,
      workspaces:
        model === undefined ? [] : listedWorkspaces({ hostKey: host.key, model, open, isQuiet }),
      summary: summarize(model === undefined ? [] : activeSessions(model), isQuiet),
      collapsed: collapsed.includes(host.key),
    };
  });

/** The shown Workspace chips in bar order: ⌃1 is the first, ⌃0 the tenth; hidden ones left out. */
export const barWorkspaces = (hosts: ReadonlyArray<BarHost>): ReadonlyArray<BarWorkspace> =>
  hosts.flatMap((h) => h.workspaces.filter((w) => !w.hidden));

/** The chips that take ⌃N, in order: the shown ones on Hosts that aren't collapsed. */
export const keyedWorkspaces = (hosts: ReadonlyArray<BarHost>): ReadonlyArray<BarWorkspace> =>
  barWorkspaces(hosts.filter((h) => !h.collapsed));

/** Whether a Workspace is registered on a Host, shown or hidden. */
export const isRegistered = (
  models: Readonly<Record<string, HostModel>>,
  hostKey: string | null,
  workspaceId: WorkspaceId | null
): boolean =>
  hostKey !== null &&
  workspaceId !== null &&
  (models[hostKey]?.workspaces.has(workspaceId) ?? false);

/** "⌃1" … "⌃9", "⌃0" for the tenth ("Ctrl+1" off macOS); nothing past it. */
export const shortcutLabel = (
  index: number,
  platform: KeyPlatform = currentKeyPlatform()
): string | undefined => acceleratorLabel(digitChord(index, platform), platform);

/** A span along the bar's scroll axis, in px. */
export interface Span {
  readonly start: number;
  readonly size: number;
}

/**
 * The bar's scroll offset that brings the open chip into view with `pad` px of room,
 * scrolling as little as it can: the bar has no scrollbar, so a chip past its edge is unseen.
 */
export const revealOffset = (view: Span, item: Span, pad: number): number => {
  if (item.start - pad < view.start) return Math.max(0, item.start - pad);

  const end = item.start + item.size + pad;

  return end > view.start + view.size ? end - view.size : view.start;
};

/** Which edges of a scrolling bar have chips past them; 1px of slack absorbs subpixel widths. */
export type EdgeFade = "none" | "start" | "end" | "both";

export const edgeFade = (scroll: {
  readonly offset: number;
  readonly view: number;
  readonly content: number;
}): EdgeFade => {
  const before = scroll.offset > 1;
  const after = scroll.offset + scroll.view < scroll.content - 1;

  if (before && after) return "both";

  if (before) return "start";

  return after ? "end" : "none";
};
