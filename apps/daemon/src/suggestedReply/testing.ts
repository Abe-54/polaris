import {
  AgentSession,
  HARNESS_CATALOGUE,
  HarnessAvailability,
  type HarnessKind,
  type HarnessStatus,
  HostHarnesses,
  type PermissionMode,
  SessionId,
  type SessionOrigin,
  type SessionWorker,
  type SessionState,
  Turn,
  TurnId,
  type TurnStatus,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import type { SessionRecord } from "../store/model.ts";

export const at = "2026-11-10T00:00:00.000Z";

export const workspaceId = WorkspaceId.make("ws-1");

export const sessionId = SessionId.make("s-1");

export const workspace = new Workspace({
  id: workspaceId,
  path: "/repo",
  name: "repo",
  isGitRepo: true,
  worktreeRoot: "/repo.worktrees",
  hidden: false,
  registeredAt: at,
});

export const agentSession = (
  options: {
    harness?: HarnessKind;
    permissionMode?: PermissionMode;
    state?: SessionState;
    origin?: SessionOrigin;
    id?: SessionId;
    worker?: SessionWorker;
  } = {}
) =>
  new AgentSession({
    id: options.id ?? sessionId,
    workspaceId,
    harness: options.harness ?? "codex",
    title: "t",
    cwd: "/repo",
    worktreeId: null,
    state: options.state ?? "idle",
    origin: options.origin ?? null,
    worker: options.worker ?? null,
    permissionMode: options.permissionMode ?? "supervised",
    model: null,
    effort: null,
    parentSessionId: null,
    forkedFromTurnId: null,
    harnessCursor: null,
    turnCount: 0,
    contextUsage: null,
    lastError: null,
    createdAt: at,
    updatedAt: at,
  });

/** Turn fields the rules read besides its status. */
export interface TurnExtras {
  readonly userTurnNumber?: number;
  readonly idleCompaction?: boolean;
  readonly shellCommand?: string;
  readonly sessionId?: SessionId;
  readonly trigger?: Turn["trigger"];
  readonly startedAt?: string;
}

/** The `index`th Turn (user Turn `index + 1`), ended with `status` unless it's `working`. */
export const turn = (
  index: number,
  status: TurnStatus = "completed",
  prompt = `ask ${index}`,
  extras: TurnExtras = {}
) =>
  new Turn({
    id: TurnId.make(
      extras.sessionId === undefined ? `t-${index}` : `${extras.sessionId}-t-${index}`
    ),
    sessionId: extras.sessionId ?? sessionId,
    trigger: extras.trigger ?? null,
    index,
    prompt,
    userTurnNumber: extras.userTurnNumber ?? index + 1,
    idleCompaction: extras.idleCompaction ?? null,
    shellCommand: extras.shellCommand ?? null,
    attachments: [],
    model: null,
    effort: null,
    status,
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: extras.startedAt ?? at,
    endedAt: status === "working" ? null : at,
  });

export const record = (session: AgentSession, turns: ReadonlyArray<Turn>): SessionRecord => ({
  session,
  titleLocked: false,
  turns,
  pending: new Map(),
  subagents: new Map(),
});

/** Each listed Harness `ready`, every other one `not-installed`. */
export const report = (...ready: ReadonlyArray<HarnessKind>) =>
  new HostHarnesses({
    harnesses: HARNESS_CATALOGUE.map(
      (entry) =>
        new HarnessAvailability({
          harness: entry.kind,
          status: (ready.includes(entry.kind) ? "ready" : "not-installed") satisfies HarnessStatus,
          version: null,
          minVersion: entry.minVersion,
          olderThanTested: null,
          signInKind: null,
          detail: null,
          signInArgv: null,
        })
    ),
    checkedAt: at,
  });
