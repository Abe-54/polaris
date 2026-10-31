/**
 * The app state Traces' previews and tests start from: Mac Studio connected with every
 * capability, the ledger Workspace and "Fix overdue totals" in its checkout.
 */
import {
  AgentSession,
  Capability,
  HostId,
  Sequence,
  SessionSummary,
  Workspace,
  Worktree,
  WorktreeId,
} from "@polaris/protocol";
import type { HostView } from "../../../../shared/api.ts";
import { modelFromSnapshot } from "../../../store/hostModel.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { FIXTURE_CHECKOUT, FIXTURE_SESSION } from "./fixtures.ts";

export const HOST = "local";

const NOW = "2026-10-31T14:03:00.000Z";

/** The session's checkout, so the Editor can open its files and the header names its branch. */
const WORKTREE = WorktreeId.make("wt-overdue-totals");

export const host: HostView = {
  key: HOST,
  label: "Mac Studio",
  colour: null,
  alias: null,
  kind: "local",
  proofHarness: false,
  status: {
    state: "connected",
    failure: null,
    attempt: 0,
    since: 0,
    nextAttemptAt: null,
    host: {
      hostId: HostId.make("h-studio"),
      hostname: "studio",
      platform: "darwin-arm64",
      daemonVersion: "0.0.0",
      homeDir: "/Users/lucas",
      startedAt: "2026-10-31T00:00:00.000Z",
    },
    capabilities: Capability.literals,
    epoch: 1,
    latencyMs: null,
    lastSeenAt: null,
  },
};

/** `shown` replaces the Host as the app sees it (reconnecting, an older Daemon). */
export const fixtureAppState = (shown: HostView = host): AppState => ({
  ...initialState,
  hosts: [shown],
  hostsListed: true,
  hostModels: {
    [HOST]: modelFromSnapshot({
      sequence: Sequence.make(1),
      workspaces: [
        new Workspace({
          id: FIXTURE_CHECKOUT.workspaceId,
          path: "/Users/lucas/code/ledger",
          name: "ledger",
          isGitRepo: true,
          worktreeRoot: "/Users/lucas/code/ledger.worktrees",
          hidden: false,
          registeredAt: NOW,
        }),
      ],
      worktrees: [
        new Worktree({
          id: WORKTREE,
          workspaceId: FIXTURE_CHECKOUT.workspaceId,
          path: FIXTURE_CHECKOUT.checkout,
          branch: "overdue-totals",
          head: "4c1e0a9",
          createdBySessionId: FIXTURE_SESSION,
          isMain: false,
        }),
      ],
      sessions: [
        new SessionSummary({
          session: new AgentSession({
            id: FIXTURE_SESSION,
            workspaceId: FIXTURE_CHECKOUT.workspaceId,
            harness: "claude",
            title: "Fix overdue totals",
            cwd: FIXTURE_CHECKOUT.checkout,
            worktreeId: WORKTREE,
            state: "idle",
            permissionMode: "supervised",
            model: null,
            effort: null,
            parentSessionId: null,
            forkedFromTurnId: null,
            harnessCursor: null,
            turnCount: 12,
            contextUsage: null,
            lastError: null,
            createdAt: NOW,
            updatedAt: NOW,
          }),
          pendingApprovals: [],
          lastTurnPreview: null,
          subagents: [],
        }),
      ],
    }),
  },
});
