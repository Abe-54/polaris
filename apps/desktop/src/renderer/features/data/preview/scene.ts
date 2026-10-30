/**
 * The Host around the Data fixtures (Paper D1): Mac Studio, the ledger Workspace, the
 * overdue-totals Worktree and its two agents, Fix overdue totals (Working) and Backfill currency
 * (Needs You on its write). For previews, screenshots and tests.
 */
import {
  AgentSession,
  Capability,
  type ConnectionState,
  HostId,
  Sequence,
  SessionId,
  Workspace,
  WorkspaceId,
  Worktree,
  WorktreeId,
} from "@polaris/protocol";
import type { HostView } from "../../../../shared/api.ts";
import { type HostModel, modelFromSnapshot, type SessionEntry } from "../../../store/hostModel.ts";
import { FIXTURE_NOW, FIXTURE_SESSIONS } from "./fixtures.ts";

const ago = (minutes: number) => new Date(FIXTURE_NOW - minutes * 60_000).toISOString();

export const DATA_HOST_KEY = "local";

export const DATA_WORKSPACE_ID = WorkspaceId.make("w-ledger");

/** Mac Studio, connected unless a state is given (Reconnecting and Offline dim the sidebar). */
export const dataHost = (state: ConnectionState = "connected"): HostView => ({
  key: DATA_HOST_KEY,
  label: "Mac Studio",
  colour: null,
  alias: null,
  kind: "local",
  proofHarness: false,
  status: {
    state,
    failure: null,
    attempt: state === "connected" ? 0 : 3,
    since: 0,
    nextAttemptAt: null,
    host: {
      hostId: HostId.make("h-local"),
      hostname: "mac-studio",
      platform: "darwin-arm64",
      daemonVersion: "0.0.0",
      homeDir: "/Users/lucas",
      startedAt: ago(600),
    },
    capabilities: Capability.literals,
    epoch: 1,
    latencyMs: null,
    lastSeenAt: state === "connected" ? null : FIXTURE_NOW - 60_000,
  },
});

const WORKTREE = WorktreeId.make("wt-overdue-totals");

const session = (
  id: SessionId,
  title: string,
  harness: string,
  state: AgentSession["state"],
  minutes: number
): SessionEntry => ({
  session: new AgentSession({
    id,
    workspaceId: DATA_WORKSPACE_ID,
    harness,
    title,
    cwd: "/Users/lucas/code/ledger.worktrees/overdue-totals",
    worktreeId: WORKTREE,
    state,
    permissionMode: "supervised",
    model: null,
    effort: null,
    parentSessionId: null,
    forkedFromTurnId: null,
    harnessCursor: null,
    turnCount: 12,
    contextUsage: null,
    lastError: null,
    createdAt: ago(minutes),
    updatedAt: ago(1),
  }),
  pendingApprovals: [],
  lastTurnPreview: null,
  subagents: [],
});

/** The ledger Workspace with the overdue-totals Worktree and the fixtures' two sessions. */
export const dataHostModel = (): HostModel => {
  const workspace = new Workspace({
    id: DATA_WORKSPACE_ID,
    path: "/Users/lucas/code/ledger",
    name: "ledger",
    isGitRepo: true,
    worktreeRoot: "/Users/lucas/code/ledger.worktrees",
    hidden: false,
    registeredAt: ago(60 * 24 * 30),
  });

  const worktree = new Worktree({
    id: WORKTREE,
    workspaceId: DATA_WORKSPACE_ID,
    path: "/Users/lucas/code/ledger.worktrees/overdue-totals",
    branch: "lucas/eng-212-overdue-totals",
    head: "4f2c9e1",
    createdBySessionId: FIXTURE_SESSIONS.overdue.id,
    isMain: false,
  });

  const entries = [
    session(
      FIXTURE_SESSIONS.backfill.id,
      FIXTURE_SESSIONS.backfill.title,
      "codex",
      "needs-you",
      42
    ),
    session(FIXTURE_SESSIONS.overdue.id, FIXTURE_SESSIONS.overdue.title, "claude", "working", 300),
  ];

  return {
    ...modelFromSnapshot({
      sequence: Sequence.make(40),
      workspaces: [workspace],
      worktrees: [worktree],
      sessions: [],
    }),
    sessions: new Map(entries.map((e) => [e.session.id, e])),
    synchronized: true,
  };
};

/** Where Data shows: the overdue-totals session on Mac Studio. */
export const DATA_AT = { hostKey: DATA_HOST_KEY, sessionId: FIXTURE_SESSIONS.overdue.id };
