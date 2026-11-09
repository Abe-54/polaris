/** Protocol values for the renderer store's tests. */
import {
  AgentSession,
  ApprovalRequest,
  DomainEvent,
  EventEnvelope,
  RequestId,
  Sequence,
  SessionId,
  Turn,
  TurnId,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";

export const at = "2026-09-29T00:00:00.000Z";

export const workspaceId = WorkspaceId.make("w1");

export const sessionId = SessionId.make("s1");

export const turnId = TurnId.make("t1");

export const workspace = new Workspace({
  id: workspaceId,
  path: "/tmp/proof",
  name: "proof",
  isGitRepo: false,
  worktreeRoot: "/tmp/proof.worktrees",
  hidden: false,
  registeredAt: at,
});

export const session = new AgentSession({
  id: sessionId,
  workspaceId,
  harness: "claude",
  title: "Proof session",
  cwd: "/tmp/proof",
  worktreeId: null,
  state: "starting",
  permissionMode: "auto",
  model: null,
  effort: null,
  serviceTier: null,
  parentSessionId: null,
  forkedFromTurnId: null,
  harnessCursor: null,
  turnCount: 0,
  contextUsage: null,
  lastError: null,
  createdAt: at,
  updatedAt: at,
});

const turnFields = {
  id: turnId,
  sessionId,
  index: 0,
  prompt: "count to three",
  trigger: null,
  userTurnNumber: null,
  replyPreview: null,
  attachments: [],
  status: "working",
  checkpointBefore: null,
  checkpointAfter: null,
  startedAt: at,
  endedAt: null,
  model: null,
  effort: null,
  serviceTier: null,
  feedback: null,
  shellCommand: null,
  idleCompaction: null,
  checkpointAfterCommit: null,
} satisfies Turn;

export const turn = new Turn(turnFields);

export const turnWith = (patch: Partial<Turn>) => new Turn({ ...turnFields, ...patch });

export const approval = new ApprovalRequest({
  id: RequestId.make("r1"),
  sessionId,
  turnId,
  kind: "command",
  title: "Run bun test",
  detail: null,
  options: [],
  openedAt: at,
});

export const envelope = (sequence: number, event: DomainEvent) =>
  new EventEnvelope({ sequence: Sequence.make(sequence), occurredAt: at, commandId: null, event });

export const seq = (n: number) => Sequence.make(n);
