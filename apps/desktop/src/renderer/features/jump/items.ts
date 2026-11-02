/**
 * What the K jump menu can reach, across every Host: Agent Sessions,
 * Workspaces, Worktrees and machines, each with the words it can be found by.
 * Built from the store, so results follow live state. Commands live in the
 * Command Palette (⇧⌘P), not here (spec Q21).
 */
import {
  isWorkerSession,
  type SessionId,
  type SessionState,
  type WorkspaceId,
  type WorktreeId,
} from "@polaris/protocol";
import { harnessHue } from "@polaris/ui";
import type { OpenPull } from "../../../shared/api.ts";
import { recentKey } from "../../routes/selection.ts";
import {
  activeSessions,
  type BarHost,
  type BarWorkspace,
  barWorkspaces,
  keyedWorkspaces,
  hiddenWorkspaces,
  shortcutLabel,
  shownState,
  summarize,
} from "../../routes/topBar.ts";
import { connectionLabel, homePath, plural, sessionStateLabel } from "../../shell/copy.ts";
import type { HostModel } from "../../store/hostModel.ts";
import type { Searchable } from "./ranking.ts";

export type JumpTarget =
  | { readonly kind: "session"; readonly hostKey: string; readonly sessionId: SessionId }
  | { readonly kind: "workspace"; readonly hostKey: string; readonly workspaceId: WorkspaceId }
  | {
      readonly kind: "worktree";
      readonly hostKey: string;
      readonly worktreeId: WorktreeId;
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId | null;
    }
  | { readonly kind: "host"; readonly hostKey: string }
  /** Review: a pull request, a file of the open Review, or one of its Risk Findings. */
  | { readonly kind: "pull"; readonly pull: OpenPull }
  | { readonly kind: "file"; readonly path: string }
  | {
      readonly kind: "finding";
      readonly findingId: string;
      readonly path: string;
      readonly line: number;
      readonly side: "new" | "old";
    };

export interface JumpItem extends Searchable {
  /** Unique across the menu; also the recent-items key for sessions and Workspaces. */
  readonly id: string;
  readonly target: JumpTarget;
  readonly detail: string;
  readonly meta: string;
  readonly state: SessionState | null;
  readonly harness: string | null;
  readonly needsYou: boolean;
}

const harnessName = (kind: string) => harnessHue(kind).name;

export interface JumpData {
  readonly bar: ReadonlyArray<BarHost>;
  readonly models: Readonly<Record<string, HostModel>>;
  readonly machineBar: boolean;
}

export const sessionItems = ({ bar, models }: JumpData): ReadonlyArray<JumpItem> =>
  bar.flatMap(({ host }) => {
    const model = models[host.key];

    if (model === undefined) return [];

    // A Constellation worker is reached through its Lead, unless it needs you (ENG-586).
    const listed = activeSessions(model).filter(
      (entry) => !isWorkerSession(entry.session) || shownState(entry) === "needs-you"
    );

    return listed.map((entry): JumpItem => {
      const { session } = entry;
      const state = shownState(entry);
      const workspace = model.workspaces.get(session.workspaceId)?.name ?? "";
      const harness = harnessName(session.harness);

      return {
        id: recentKey("session", host.key, session.id),
        target: { kind: "session", hostKey: host.key, sessionId: session.id },
        title: session.title || "Untitled session",
        keywords: [workspace, host.label, sessionStateLabel[state], harness, session.harness],
        detail: "",
        meta: [capitalized(sessionStateLabel[state]), workspace, host.label]
          .filter((part) => part !== "")
          .join(" · "),
        state,
        harness: session.harness,
        needsYou: state === "needs-you",
      };
    });
  });

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const workspaceItem = (bar: ReadonlyArray<BarHost>, w: BarWorkspace, meta: string): JumpItem => {
  const view = bar.find((h) => h.host.key === w.hostKey)?.host;
  const host = view?.label ?? "";
  const path = homePath(w.workspace.path, view?.status.host?.homeDir ?? null);

  return {
    id: recentKey("workspace", w.hostKey, w.workspace.id),
    target: { kind: "workspace", hostKey: w.hostKey, workspaceId: w.workspace.id },
    title: w.workspace.name,
    keywords: [host, "workspace", ...(w.hidden ? ["hidden"] : [])],
    detail: `${host} · ${path}`,
    meta,
    state: w.summary.state,
    harness: w.summary.harness,
    needsYou: w.summary.needsYou > 0,
  };
};

/**
 * The shown chips with their ⌃N (none on a collapsed Host), then every hidden Workspace, marked
 * "hidden" (it can be opened).
 */
export const workspaceItems = ({ bar, models, machineBar }: JumpData): ReadonlyArray<JumpItem> => {
  const keyed = keyedWorkspaces(bar);

  const shown = barWorkspaces(bar).map((w) => {
    const index = keyed.indexOf(w);

    return workspaceItem(bar, w, machineBar || index < 0 ? "" : (shortcutLabel(index) ?? ""));
  });

  const hidden = bar.flatMap(({ host }) => {
    const model = models[host.key];

    if (model === undefined) return [];

    return hiddenWorkspaces(model).map((workspace) =>
      workspaceItem(
        bar,
        {
          hostKey: host.key,
          workspace,
          summary: summarize(activeSessions(model, workspace.id)),
          hidden: true,
        },
        "hidden"
      )
    );
  });

  return [...shown, ...hidden];
};

export const worktreeItems = ({ bar, models }: JumpData): ReadonlyArray<JumpItem> =>
  bar.flatMap(({ host }) => {
    const model = models[host.key];

    if (model === undefined) return [];

    return [...model.worktrees.values()].flatMap((wt): Array<JumpItem> => {
      if (wt.isMain) return [];
      const workspace = model.workspaces.get(wt.workspaceId)?.name ?? "";
      const branch = wt.branch ?? wt.head.slice(0, 7);

      return [
        {
          id: `worktree\u0000${host.key}\u0000${wt.id}`,
          target: {
            kind: "worktree",
            hostKey: host.key,
            worktreeId: wt.id,
            workspaceId: wt.workspaceId,
            sessionId: wt.createdBySessionId,
          },
          title: branch,
          keywords: [workspace, host.label, "worktree"],
          detail: `${host.label} / ${workspace}`,
          meta: "worktree",
          state: null,
          harness: null,
          needsYou: false,
        },
      ];
    });
  });

export const hostItems = ({ bar, machineBar }: JumpData): ReadonlyArray<JumpItem> =>
  bar.map(({ host, workspaces, summary }, index): JumpItem => ({
    id: `host\u0000${host.key}`,
    target: { kind: "host", hostKey: host.key },
    title: host.label,
    keywords: [host.alias ?? "", "machine", "host", connectionLabel[host.status.state]],
    detail:
      host.status.state === "connected"
        ? plural(workspaces.filter((w) => !w.hidden).length, "workspace")
        : connectionLabel[host.status.state],
    meta: machineBar ? (shortcutLabel(index) ?? "") : "",
    state: summary.state,
    harness: summary.harness,
    needsYou: summary.needsYou > 0,
  }));
