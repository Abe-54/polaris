/**
 * What the commands list, from every Host's view: Agent Sessions in sections
 * by what they need from the user, approvals oldest first, and Workspaces.
 */
import type { ApprovalRequest, HostView, SessionEntry, Workspace } from "@polaris/sdk";

/** Every Host, or one. */
export type HostFilter = string | null;

export const sessionKey = (hostId: string, sessionId: string): string => `${hostId}/${sessionId}`;

export interface SessionRow {
  readonly key: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly entry: SessionEntry;
  readonly workspaceName: string;
  /** When the latest Turn started; the last update before the first. */
  readonly lastTurnAt: string;
  readonly pinned: boolean;
}

export interface SessionSection {
  readonly title: "Needs You" | "Working" | "Idle" | "Archived";
  readonly rows: ReadonlyArray<SessionRow>;
}

export interface SessionQuery {
  readonly host: HostFilter;
  /** Keys (`sessionKey`) the user pinned; they lead their section. */
  readonly pinned: ReadonlySet<string>;
  /** Archived sessions are listed only while the user searches. */
  readonly searching: boolean;
}

const shown = (views: ReadonlyArray<HostView>, host: HostFilter) =>
  views.filter((view) => host === null || view.hostId === host);

const lastPathPart = (path: string) => path.split("/").findLast((part) => part !== "") ?? path;

const rowOf = (view: HostView, entry: SessionEntry, pinned: ReadonlySet<string>): SessionRow => {
  const { session } = entry;
  const key = sessionKey(view.hostId, session.id);
  const workspace = view.workspaces.find((w) => w.id === session.workspaceId);

  return {
    key,
    hostId: view.hostId,
    hostName: view.hostName,
    entry,
    workspaceName: workspace?.name ?? lastPathPart(session.cwd),
    lastTurnAt: session.currentUserTurn?.startedAt ?? session.updatedAt,
    pinned: pinned.has(key),
  };
};

const sectionOf = (entry: SessionEntry): SessionSection["title"] => {
  const { state } = entry.session;

  if (state === "needs-you" || entry.pendingApprovals.length > 0) return "Needs You";

  if (state === "working" || state === "starting") return "Working";

  return state === "archived" ? "Archived" : "Idle";
};

const byRecency = (a: SessionRow, b: SessionRow) =>
  Number(b.pinned) - Number(a.pinned) || b.lastTurnAt.localeCompare(a.lastTurnAt);

const ORDER: ReadonlyArray<SessionSection["title"]> = ["Needs You", "Working", "Idle", "Archived"];

export const sessionSections = (
  views: ReadonlyArray<HostView>,
  query: SessionQuery
): ReadonlyArray<SessionSection> => {
  const rows = shown(views, query.host).flatMap((view) =>
    [...view.sessions, ...(query.searching ? view.archived : [])].map((entry) =>
      rowOf(view, entry, query.pinned)
    )
  );

  return ORDER.flatMap((title) => {
    const inSection = rows.filter((row) => sectionOf(row.entry) === title).sort(byRecency);

    return inSection.length === 0 ? [] : [{ title, rows: inSection }];
  });
};

export interface ApprovalRow {
  readonly key: string;
  readonly approval: ApprovalRequest;
  readonly session: SessionRow;
}

/** Every pending approval, oldest first: the one waiting longest leads. */
export const approvalRows = (
  views: ReadonlyArray<HostView>,
  host: HostFilter
): ReadonlyArray<ApprovalRow> =>
  shown(views, host)
    .flatMap((view) =>
      view.sessions.flatMap((entry) =>
        entry.pendingApprovals.map((approval) => ({
          key: `${sessionKey(view.hostId, entry.session.id)}/${approval.id}`,
          approval,
          session: rowOf(view, entry, new Set()),
        }))
      )
    )
    .sort((a, b) => a.approval.openedAt.localeCompare(b.approval.openedAt));

export interface WorkspaceRow {
  readonly key: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly workspace: Workspace;
  /** Agent Sessions in it that aren't archived. */
  readonly sessionCount: number;
}

export const workspaceRows = (
  views: ReadonlyArray<HostView>,
  host: HostFilter
): ReadonlyArray<WorkspaceRow> =>
  shown(views, host).flatMap((view) =>
    view.workspaces
      .map((workspace) => ({
        key: `${view.hostId}/${workspace.id}`,
        hostId: view.hostId,
        hostName: view.hostName,
        workspace,
        sessionCount: view.sessions.filter((e) => e.session.workspaceId === workspace.id).length,
      }))
      .sort((a, b) => a.workspace.name.localeCompare(b.workspace.name))
  );

export const offersAlwaysAllow = (approval: ApprovalRow["approval"]) =>
  approval.profileAttach === undefined;
