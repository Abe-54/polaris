/** Host views for the extension's unit tests, built from the protocol's own classes. */
import {
  AgentSession,
  ApprovalRequest,
  RequestId,
  SessionId,
  TurnId,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import type { HostView, SessionEntry } from "@polaris/sdk";

export const workspace = (id: string, name: string) =>
  new Workspace({
    id: WorkspaceId.make(id),
    path: `/Users/me/code/${name}`,
    name,
    isGitRepo: true,
    worktreeRoot: `/Users/me/code/${name}.worktrees`,
    hidden: false,
    registeredAt: "2026-10-01T00:00:00.000Z",
  });

export const approval = (sessionId: string, id: string, openedAt: string) =>
  new ApprovalRequest({
    id: RequestId.make(id),
    sessionId: SessionId.make(sessionId),
    turnId: TurnId.make("t1"),
    kind: "command",
    title: `Wants to run ${id}`,
    detail: null,
    options: [],
    openedAt,
  });

export const entry = (
  id: string,
  state: AgentSession["state"],
  updatedAt: string,
  extra: { readonly workspaceId?: string; readonly approvals?: ReadonlyArray<ApprovalRequest> } = {}
): SessionEntry => ({
  session: new AgentSession({
    id: SessionId.make(id),
    workspaceId: WorkspaceId.make(extra.workspaceId ?? "w1"),
    harness: "claude",
    title: id,
    cwd: "/Users/me/code/elsewhere",
    worktreeId: null,
    state,
    permissionMode: "supervised",
    model: null,
    effort: null,
    parentSessionId: null,
    forkedFromTurnId: null,
    harnessCursor: null,
    turnCount: 1,
    contextUsage: null,
    lastError: null,
    createdAt: updatedAt,
    updatedAt,
  }),
  pendingApprovals: extra.approvals ?? [],
  lastTurnPreview: null,
});

export const hostView = (
  hostId: string,
  entries: ReadonlyArray<SessionEntry>,
  workspaces: ReadonlyArray<Workspace> = [workspace("w1", "polaris")]
): HostView => ({
  hostId,
  hostName: `Host ${hostId}`,
  connected: true,
  error: null,
  capabilities: ["session.plan-mode"],
  workspaces,
  sessions: entries.filter((e) => e.session.state !== "archived"),
  archived: entries.filter((e) => e.session.state === "archived"),
  approvals: entries.flatMap((e) => e.pendingApprovals),
});
