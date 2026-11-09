import { Schema } from "effect";
import { HarnessKind } from "../harnesses.ts";
import { HostId, SessionId, Timestamp, TurnId, WorkspaceId } from "../ids.ts";
import { ModelId, optionalArray, optionalNullable, ReasoningEffort } from "../models.ts";
import { WorkerLiveness } from "./liveness.ts";

export const ConstellationId = Schema.String.pipe(Schema.brand("ConstellationId"));

export type ConstellationId = typeof ConstellationId.Type;

export const TaskId = Schema.NonEmptyString.pipe(Schema.brand("TaskId"));

/**
 * What a new Task id may contain: it names worktree and branch path components (ENG-741).
 * Checked when a Task is declared, not on TaskId, so logs with older ids still decode.
 */
export const taskIdPattern = /^[A-Za-z0-9_-]+$/;

export type TaskId = typeof TaskId.Type;

export const AttemptId = Schema.String.pipe(Schema.brand("AttemptId"));

export type AttemptId = typeof AttemptId.Type;

export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export type Revision = typeof Revision.Type;

export const ConstellationState = Schema.Literals([
  "planning",
  "running",
  "paused",
  "completed",
  "archived",
]);

export type ConstellationState = typeof ConstellationState.Type;

export const AttemptState = Schema.Literals([
  "working",
  "blocked",
  "review",
  "accepted",
  "rejected",
  "lost",
  "failed",
]);

export type AttemptState = typeof AttemptState.Type;

export const TaskState = Schema.Literals([
  "waiting",
  "ready",
  "working",
  "blocked",
  "review",
  "done",
  "canceled",
  "lost",
  "failed",
]);

export type TaskState = typeof TaskState.Type;

export const EvidenceTier = Schema.Literals(["verified", "reported", "asserted"]);

export type EvidenceTier = typeof EvidenceTier.Type;

/** Why a mechanical settle happened; `implementation` is never inferred from a Harness failure. */
export const FailureKind = Schema.Literals(["capacity", "transport", "harness", "implementation"]);

export type FailureKind = typeof FailureKind.Type;

/** What a stall audit found: `key` is stable for one stalled state, so one audit is noted once. */
export class StallAudit extends Schema.Class<StallAudit>("ConstellationStallAudit")({
  key: Schema.NonEmptyString,
  /** Working Attempts with no active Turn and no queued input. */
  working: Schema.Array(TaskId),
  /** Promoted Gates with no active Attempt. */
  gates: Schema.Array(TaskId),
  /** The Lead has no active Turn while Claims, ready Tasks or Gates wait on it. */
  lead: Schema.Boolean,
  /**
   * Working Attempts newly stalled: holding a worker slot with no first Turn past the grace
   * period (`workerPhase`). Each is named once; absent from an older Daemon.
   */
  slots: Schema.optionalKey(Schema.Array(AttemptId)),
}) {}

export const Area = Schema.Array(Schema.NonEmptyString);

export type Area = typeof Area.Type;

export class ConstellationFinding extends Schema.Class<ConstellationFinding>(
  "ConstellationFinding"
)({
  code: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  fix: Schema.NonEmptyString,
}) {}

export class HarnessSelection extends Schema.Class<HarnessSelection>("HarnessSelection")({
  harness: Schema.optionalKey(HarnessKind),
  model: Schema.optionalKey(ModelId),
  effort: Schema.optionalKey(ReasoningEffort),
}) {}

export class TaskDefinition extends Schema.Class<TaskDefinition>("TaskDefinition")({
  id: TaskId,
  title: Schema.NonEmptyString,
  kind: Schema.Literals(["task", "gate"]),
  deps: optionalArray(TaskId),
  area: optionalArray(Schema.NonEmptyString),
  brief: Schema.String,
  criteria: optionalArray(Schema.String),
  suggested: optionalNullable(HarnessSelection),
  group: optionalNullable(Schema.String),
  parent: optionalNullable(TaskId),
}) {}

/**
 * An Edit's changes: an omitted field keeps its value, null or [] clears it (ENG-412).
 * `id`, when given, must match the edited Task.
 */
export const TaskPatch = Schema.Struct({
  id: Schema.optionalKey(TaskId),
  title: Schema.optionalKey(Schema.NonEmptyString),
  kind: Schema.optionalKey(TaskDefinition.fields.kind),
  deps: Schema.optionalKey(Schema.NullOr(Schema.Array(TaskId))),
  area: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.NonEmptyString))),
  brief: Schema.optionalKey(Schema.NullOr(Schema.String)),
  criteria: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  suggested: Schema.optionalKey(Schema.NullOr(HarnessSelection)),
  group: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parent: Schema.optionalKey(Schema.NullOr(TaskId)),
});

export type TaskPatch = typeof TaskPatch.Type;

/** Task state and Gate readiness are derived from Attempts, never written here. */
export class Task extends Schema.Class<Task>("ConstellationTask")({
  ...TaskDefinition.fields,
  revision: Revision,
  canceled: Schema.Boolean,
}) {}

export const AttemptCause = Schema.TaggedUnion({
  Initial: {},
  SentBack: { ref: AttemptId },
  MergeConflict: { ref: AttemptId, base: Schema.NonEmptyString },
  Recover: { ref: AttemptId },
  Followup: { ref: AttemptId },
  Superseded: { ref: AttemptId },
});

export type AttemptCause = typeof AttemptCause.Type;

/** Verified receipts reference the persisted item; callers cannot supply its output as proof. */
export class ToolCallReference extends Schema.Class<ToolCallReference>("ToolCallReference")({
  hostId: HostId,
  sessionId: SessionId,
  turnId: TurnId,
  itemId: Schema.NonEmptyString,
}) {}

export const CheckReceipt = Schema.TaggedUnion({
  Verified: { label: Schema.NonEmptyString, item: ToolCallReference },
  Reported: {
    label: Schema.NonEmptyString,
    text: Schema.NonEmptyString,
    command: optionalNullable(Schema.String),
    exitCode: optionalNullable(Schema.Int),
  },
});

export type CheckReceipt = typeof CheckReceipt.Type;

export class ConstellationQuestion extends Schema.Class<ConstellationQuestion>(
  "ConstellationQuestion"
)({
  id: Schema.NonEmptyString,
  to: Schema.Literals(["lead", "user"]),
  text: Schema.NonEmptyString,
  blocking: Schema.Boolean,
}) {}

/** A worker's question waiting on its answer; it closes when answered or its Attempt settles. */
export class OpenQuestion extends Schema.Class<OpenQuestion>("ConstellationOpenQuestion")({
  attemptId: AttemptId,
  question: ConstellationQuestion,
  askedAt: Timestamp,
}) {}

export class AreaException extends Schema.Class<AreaException>("AreaException")({
  path: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
}) {}

export class Claim extends Schema.Class<Claim>("ConstellationClaim")({
  branch: Schema.NonEmptyString,
  head: Schema.NonEmptyString,
  commits: Schema.Array(Schema.NonEmptyString),
  receipts: Schema.Array(CheckReceipt),
  notDone: Schema.Array(Schema.String),
  followups: Schema.Array(Schema.String),
  questions: Schema.Array(ConstellationQuestion),
  outsideArea: Schema.Array(AreaException),
  decisions: Schema.Array(Schema.String),
  summary: Schema.String,
}) {}

export class Attempt extends Schema.Class<Attempt>("ConstellationAttempt")({
  id: AttemptId,
  taskId: TaskId,
  revision: Revision,
  cause: AttemptCause,
  by: SessionId,
  sessionId: SessionId,
  hostId: HostId,
  worktree: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  base: Schema.NonEmptyString,
  /** Deferred setup policy, used before the durable first-Turn receipt. */
  startupSetup: optionalNullable(
    Schema.Struct({
      command: Schema.NullOr(Schema.String),
      force: Schema.optionalKey(Schema.Boolean),
    })
  ),
  state: AttemptState,
  claim: optionalNullable(Claim),
  mergedHead: optionalNullable(Schema.String),
  receipts: optionalArray(CheckReceipt),
  evidence: optionalNullable(EvidenceTier),
  /** What Accept recorded about its merge, e.g. notices it may have left stale (ENG-276). */
  acceptFindings: optionalArray(ConstellationFinding),
  /** When the worker claimed (AttemptClaimed); null before. */
  claimedAt: Schema.NullOr(Timestamp),
  /**
   * The Attempt revision its current Claim made (AttemptClaimed). A review sent at this
   * revision or later saw this Claim; bumps that leave the Claim alone don't make it stale.
   */
  claimRevision: optionalNullable(Revision),
  /** The head this Claim amended while in review (a re-claim on the same Attempt); null otherwise. */
  previousClaimHead: optionalNullable(Schema.String),
  /** The user's verdict (ClaimApproved); the Lead still merges and accepts. */
  approvedByUserAt: Schema.NullOr(Timestamp),
  /** The Lead handed the Claim up to the user (ClaimHandedUp), and why. */
  handedUpAt: Schema.NullOr(Timestamp),
  handedUpReason: Schema.NullOr(Schema.String),
  /** The verbatim SendBack feedback (the Lead's or the user's), retained beside the rejected Claim. */
  rejectionReason: optionalNullable(Schema.String),
  /** Who sent the Claim back; null before this was recorded. */
  rejectedBy: optionalNullable(Schema.Literals(["user", "lead"])),
  /** The one automatic nudge after a silent end (AttemptNudged). */
  nudgedAt: Schema.NullOr(Timestamp),
  /** Why a lost or failed Attempt settled (AttemptSettled.reason); null while active. */
  settleReason: optionalNullable(Schema.String),
  /** The classified cause of a failed settle; null for lost, accepted or active Attempts. */
  failureKind: optionalNullable(FailureKind),
  /** A capacity failure's Plan Limit reset, when the Harness reported one; null when unknown. */
  resetsAt: optionalNullable(Timestamp),
  blockedOn: optionalArray(TaskId),
  blockedReason: optionalNullable(Schema.String),
  blockedAt: optionalNullable(Timestamp),
  startedAt: Timestamp,
  endedAt: optionalNullable(Timestamp),
}) {}

export class ConstellationSettings extends Schema.Class<ConstellationSettings>(
  "ConstellationSettings"
)({
  branchPrefix: Schema.optionalKey(Schema.NonEmptyString),
  transfer: Schema.optionalKey(Schema.Literals(["bundle", "origin"])),
  defaults: optionalNullable(HarnessSelection),
  backend: optionalNullable(HarnessSelection),
  ui: optionalNullable(HarnessSelection),
  claimCoalescingMs: Schema.optionalKey(Revision),
  questionCoalescingMs: Schema.optionalKey(Revision),
}) {}

export const NotificationItem = Schema.TaggedUnion({
  Blocked: {
    taskId: TaskId,
    attemptId: AttemptId,
    on: Schema.Array(TaskId),
    reason: Schema.NonEmptyString,
  },
  Stopped: { taskId: TaskId, attemptId: AttemptId },
  Settled: {
    attemptId: AttemptId,
    state: AttemptState,
    failureKind: optionalNullable(Schema.suspend(() => FailureKind)),
    resetsAt: optionalNullable(Timestamp),
  },
  /** The user approved a Claim; the Lead merges its head and accepts it. */
  Approved: { attemptId: AttemptId },
  Question: { attemptId: AttemptId, question: ConstellationQuestion },
  Proposal: { attemptId: AttemptId, proposalId: Schema.String },
  OperatorMessage: { messageId: Schema.String, text: Schema.String },
  QuestionAnswered: { attemptId: AttemptId, questionId: Schema.String, text: Schema.String },
});

export type NotificationItem = typeof NotificationItem.Type;

export class ConstellationNotification extends Schema.Class<ConstellationNotification>(
  "ConstellationNotification"
)({
  id: Schema.NonEmptyString,
  item: NotificationItem,
  queuedAt: Timestamp,
}) {}

export class Constellation extends Schema.Class<Constellation>("Constellation")({
  id: ConstellationId,
  workspaceId: WorkspaceId,
  hostId: HostId,
  leadSessionId: SessionId,
  /**
   * The branch Accept merges into, recorded at start from the Lead's checkout (ADR 0099).
   * Absent on graphs started before it was recorded.
   */
  leadBranch: Schema.optional(Schema.NonEmptyString),
  name: Schema.NonEmptyString,
  state: ConstellationState,
  revision: Revision,
  settings: ConstellationSettings,
  tasks: Schema.Array(Task),
  attempts: Schema.Array(Attempt),
  pendingNotifications: Schema.Array(ConstellationNotification),
  /** Kept apart from the Lead's delivery queue, which each digest empties. */
  openQuestions: optionalArray(OpenQuestion),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

const LIVE_ATTEMPT: ReadonlySet<string> = new Set(["working", "blocked", "review"]);

/** The open questions whose Attempt is still live: a question closes when its Attempt settles. */
export const liveQuestions = <Q extends { readonly attemptId: string }>(
  questions: ReadonlyArray<Q>,
  attempts: ReadonlyArray<{ readonly id: string; readonly state: string }>
): ReadonlyArray<Q> =>
  questions.filter((q) => attempts.some((a) => a.id === q.attemptId && LIVE_ATTEMPT.has(a.state)));

export class TaskProjection extends Schema.Class<TaskProjection>("ConstellationTaskProjection")({
  taskId: TaskId,
  state: TaskState,
  latestAttemptId: Schema.NullOr(AttemptId),
  blockedBy: Schema.Array(TaskId),
  children: optionalArray(TaskId),
  gatePromoted: Schema.Boolean,
  stale: Schema.Boolean,
  branchFetched: Schema.Boolean,
  /** The latest Attempt's observed liveness; null when nothing has been observed. */
  liveness: Schema.NullOr(WorkerLiveness),
}) {}

/** A graph as the Host feed lists it; its contents come from `constellation.subscribe`. */
export class ConstellationSummary extends Schema.Class<ConstellationSummary>(
  "ConstellationSummary"
)({
  id: ConstellationId,
  workspaceId: WorkspaceId,
  hostId: HostId,
  leadSessionId: SessionId,
  name: Schema.NonEmptyString,
  state: ConstellationState,
  createdAt: Timestamp,
}) {}

export const constellationSummaryOf = (c: Constellation): ConstellationSummary =>
  new ConstellationSummary({
    id: c.id,
    workspaceId: c.workspaceId,
    hostId: c.hostId,
    leadSessionId: c.leadSessionId,
    name: c.name,
    state: c.state,
    createdAt: c.createdAt,
  });

export class ConstellationGraphSlice extends Schema.Class<ConstellationGraphSlice>(
  "ConstellationGraphSlice"
)({
  constellationId: ConstellationId,
  revision: Revision,
  tasks: Schema.Array(Task),
  attempts: Schema.Array(Attempt),
  projections: optionalArray(TaskProjection),
}) {}

export class HostResource extends Schema.Class<HostResource>("HostResource")({
  hostId: HostId,
  name: Schema.NonEmptyString,
  capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  holdLimitMs: Schema.optionalKey(Revision),
}) {}

export class ResourceLease extends Schema.Class<ResourceLease>("ResourceLease")({
  id: Schema.NonEmptyString,
  hostId: HostId,
  resource: Schema.NonEmptyString,
  sessionId: optionalNullable(SessionId),
  attemptId: optionalNullable(AttemptId),
  command: Schema.Array(Schema.String),
  processId: Schema.Int,
  processIdentity: Schema.optionalKey(Schema.String),
  acquiredAt: Timestamp,
}) {}
