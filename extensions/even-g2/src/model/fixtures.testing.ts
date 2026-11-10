/** Hosts, sessions and approvals for the model's tests, built with the protocol's own classes. */
import {
  AgentSession,
  AppId,
  ApprovalRequest,
  DesktopApp,
  RequestId,
  SessionId,
  type SessionState,
  TurnId,
  WorkspaceId,
} from "@polaris/protocol";
import type { HostView, SessionEntry } from "@polaris/sdk";

const minute = (n: number) => new Date(Date.UTC(2026, 9, 23, 12, n)).toISOString();

export const session = (
  id: string,
  state: SessionState,
  options: {
    readonly title?: string;
    readonly updated?: number;
    readonly lastReplyPreview?: string;
  } = {}
) =>
  new AgentSession({
    id: SessionId.make(id),
    workspaceId: WorkspaceId.make("w1"),
    harness: "claude",
    title: options.title ?? `Session ${id}`,
    cwd: "/repo",
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
    lastReplyPreview: options.lastReplyPreview ?? null,
    createdAt: minute(0),
    updatedAt: minute(options.updated ?? 0),
  });

const appOf = (name: string) => new DesktopApp({ id: AppId.make(`app.${name}`), name, icon: null });

export const approval = (
  id: string,
  sessionId: string,
  options: {
    readonly kind?: ApprovalRequest["kind"];
    readonly title?: string;
    readonly options?: ReadonlyArray<string>;
    readonly opened?: number;
    /** For `app` and `headed-input`: the app's name. */
    readonly app?: string;
  } = {}
) => {
  const fields = {
    id: RequestId.make(id),
    sessionId: SessionId.make(sessionId),
    turnId: TurnId.make("t1"),
    kind: options.kind ?? "command",
    title: options.title ?? "Run cargo build",
    detail: null,
    options: [...(options.options ?? [])],
    openedAt: minute(options.opened ?? 0),
  };

  if (options.app === undefined) return new ApprovalRequest(fields);

  return new ApprovalRequest({ ...fields, app: appOf(options.app) });
};

export const entry = (
  value: AgentSession,
  pendingApprovals: ReadonlyArray<ApprovalRequest> = []
): SessionEntry => ({ session: value, pendingApprovals, lastTurnPreview: null });

export const host = (
  hostId: string,
  entries: ReadonlyArray<SessionEntry>,
  hostName = `Host ${hostId}`
): HostView => ({
  hostId,
  hostName,
  connected: true,
  error: null,
  workspaces: [],
  sessions: entries.filter((e) => e.session.state !== "archived"),
  archived: entries.filter((e) => e.session.state === "archived"),
  approvals: entries
    .filter((e) => e.session.state !== "archived")
    .flatMap((e) => e.pendingApprovals),
});
