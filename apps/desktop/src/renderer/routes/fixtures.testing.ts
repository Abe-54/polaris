/** Hosts, Workspaces and sessions for the routing tests. */
import {
  AgentSession,
  ConstellationId,
  type SessionState,
  SessionId,
  SessionSummary,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import type { HostView } from "../../shared/api.ts";
import { modelFromSnapshot, type HostModel } from "../store/hostModel.ts";
import { seq } from "../store/fixtures.testing.ts";

export const hostView = (
  key: string,
  state: HostView["status"]["state"] = "connected"
): HostView => ({
  key,
  label: key,
  colour: null,
  alias: key === "local" ? null : key,
  kind: key === "local" ? "local" : "ssh",
  proofHarness: false,
  status: {
    state,
    failure: null,
    attempt: 0,
    since: 0,
    nextAttemptAt: null,
    host: null,
    capabilities: [],
    epoch: 1,
    latencyMs: null,
    lastSeenAt: null,
  },
});

export interface SessionSpec {
  readonly id: string;
  readonly state: SessionState;
  readonly createdAt?: string;
  /** A Constellation worker's session, as the Daemon marks it. */
  readonly worker?: boolean;
}

export interface WorkspaceSpec {
  readonly id: string;
  readonly sessions?: ReadonlyArray<SessionSpec>;
  readonly hidden?: boolean;
  readonly isGitRepo?: boolean;
}

const time = (n: number) => new Date(Date.UTC(2026, 8, 29, 0, n)).toISOString();

export const hostModel = (workspaces: ReadonlyArray<WorkspaceSpec>): HostModel =>
  modelFromSnapshot({
    sequence: seq(1),
    workspaces: workspaces.map(
      (w, i) =>
        new Workspace({
          id: WorkspaceId.make(w.id),
          path: `/code/${w.id}`,
          name: w.id,
          isGitRepo: w.isGitRepo ?? true,
          worktreeRoot: `/code/${w.id}.worktrees`,
          hidden: w.hidden ?? false,
          registeredAt: time(i),
        })
    ),
    worktrees: [],
    sessions: workspaces.flatMap((w) =>
      (w.sessions ?? []).map(
        (s) =>
          new SessionSummary({
            session: new AgentSession({
              id: SessionId.make(s.id),
              workspaceId: WorkspaceId.make(w.id),
              harness: "claude",
              title: s.id,
              cwd: `/code/${w.id}`,
              worktreeId: null,
              state: s.state,
              permissionMode: "auto",
              model: null,
              effort: null,
              parentSessionId: null,
              forkedFromTurnId: null,
              harnessCursor: null,
              turnCount: 1,
              contextUsage: null,
              lastError: null,
              worker: s.worker === true ? { constellationId: ConstellationId.make("c1") } : null,
              createdAt: s.createdAt ?? time(0),
              updatedAt: time(0),
            }),
            pendingApprovals: [],
            lastTurnPreview: null,
            subagents: [],
          })
      )
    ),
  });

/** `n` Workspaces named `${prefix}0`… with no sessions. */
export const workspaces = (prefix: string, n: number): ReadonlyArray<WorkspaceSpec> =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
