import { Effect, Schema } from "effect";
import { HostId, SessionId, TurnId, Timestamp } from "../ids.ts";
import { optionalNullable } from "../models.ts";
import {
  AttemptWaiting,
  ConstellationCommand,
  MessageAuthority,
  MessageTarget,
} from "./commands.ts";
import {
  Attempt,
  HarnessSelection,
  AttemptId,
  CheckReceipt,
  Claim,
  Constellation,
  ConstellationFinding,
  ConstellationId,
  ConstellationNotification,
  ConstellationState,
  EvidenceTier,
  FailureKind,
  HostResource,
  ResourceLease,
  Revision,
  StallAudit,
  Task,
  TaskDefinition,
  TaskId,
} from "./domain.ts";

/** A boolean added after logs were written: absent decodes and constructs as false. */
const addedFalse = Schema.Boolean.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(false)),
  Schema.withConstructorDefault(Effect.succeed(false))
);

const graph = { constellationId: ConstellationId, revision: Revision };

const attempt = { ...graph, attemptId: AttemptId, attemptRevision: Revision };

const task = { ...graph, taskId: TaskId, taskRevision: Revision };

/** Field sets shared with DomainEvent so persisted and streamed events use one codec. */
export const constellationEventFields = {
  ConstellationStarted: { ...graph, constellation: Schema.suspend(() => Constellation) },
  ConstellationStateChanged: { ...graph, state: ConstellationState },
  LeadHandoverRequested: {
    ...graph,
    requestId: Schema.String,
    from: SessionId,
    summary: Schema.String,
    interrupt: Schema.Boolean,
    selection: optionalNullable(Schema.suspend(() => HarnessSelection)),
  },
  LeadHandoverCancelled: { ...graph, requestId: Schema.String, reason: Schema.String },
  LeadChanged: {
    ...graph,
    from: SessionId,
    to: SessionId,
    summary: Schema.String,
    requestId: optionalNullable(Schema.String),
  },
  TaskDeclared: { ...graph, task: Schema.suspend(() => Task) },
  TaskEdited: { ...graph, task: Schema.suspend(() => Task) },
  TaskCanceled: task,
  TaskProposed: {
    ...graph,
    proposalId: Schema.String,
    by: AttemptId,
    task: Schema.suspend(() => TaskDefinition),
  },
  ProposalAccepted: { ...graph, proposalId: Schema.String, task: Schema.suspend(() => Task) },
  ProposalDeclined: { ...graph, proposalId: Schema.String, reason: Schema.String },
  AttemptStarted: { ...graph, attempt: Schema.suspend(() => Attempt) },
  AttemptProgressed: {
    ...attempt,
    note: Schema.String,
    completed: optionalNullable(Revision),
    total: optionalNullable(Revision),
    waiting: optionalNullable(AttemptWaiting),
  },
  AttemptClaimed: { ...attempt, claim: Schema.suspend(() => Claim) },
  ClaimApproved: { ...attempt, by: Schema.Literal("user"), at: Timestamp },
  ClaimHandedUp: { ...attempt, reason: optionalNullable(Schema.String), at: Timestamp },
  AttemptBlocked: {
    ...attempt,
    on: Schema.Array(TaskId),
    reason: Schema.NonEmptyString,
    at: Timestamp,
  },
  AttemptUnblocked: { ...attempt, cause: Schema.Literals(["Accepted", "Lead"]), at: Timestamp },
  AttemptNudged: { ...attempt, at: Timestamp },
  AttemptInterrupted: {
    ...graph,
    attemptId: AttemptId,
    turnId: TurnId,
    interruptionId: Schema.String,
    eligible: Schema.Boolean,
    at: Timestamp,
  },
  AttemptStale: { ...graph, attemptId: AttemptId, hostId: HostId, at: Timestamp },
  AttemptFresh: { ...graph, attemptId: AttemptId, at: Timestamp },
  AttemptAccepted: {
    ...attempt,
    mergedHead: Schema.String,
    receipts: Schema.Array(Schema.suspend(() => CheckReceipt)),
    evidence: EvidenceTier,
    /** Absent on events written before Accept recorded its merge's findings. */
    findings: Schema.optionalKey(Schema.Array(ConstellationFinding)),
  },
  /** `by` is null on events written before it was recorded. */
  AttemptRejected: {
    ...attempt,
    reason: Schema.String,
    by: optionalNullable(Schema.Literals(["user", "lead"])),
  },
  AttemptSettled: {
    ...attempt,
    outcome: Schema.Literals(["lost", "failed"]),
    reason: Schema.String,
    /** Classified from the Harness failure; null for a commanded or lost settle. */
    failureKind: optionalNullable(FailureKind),
    /** A capacity failure's Plan Limit reset, when known. Nothing redispatches at it. */
    resetsAt: optionalNullable(Timestamp),
  },
  GatePromoted: task,
  NotificationQueued: { ...graph, notification: Schema.suspend(() => ConstellationNotification) },
  /** `steered` lands the digest in the Lead's working Turn; otherwise `turnId` is a new Turn. */
  LeadNotified: {
    ...graph,
    leadSessionId: SessionId,
    items: Schema.Array(Schema.String),
    turnId: TurnId,
    steered: addedFalse,
    /** A stall audit delivered with (or instead of) items; null when nothing stalled. */
    audit: optionalNullable(Schema.suspend(() => StallAudit)),
  },
  OperatorMessageSent: {
    ...graph,
    id: Schema.String,
    authority: MessageAuthority,
    target: Schema.suspend(() => MessageTarget),
    text: Schema.String,
    questionId: optionalNullable(Schema.String),
  },
  WorkerInputDelivered: { ...graph, id: Schema.String, sessionId: SessionId, at: Timestamp },
  OperatorMessageResolved: { ...graph, id: Schema.String },
  PeerMessage: { ...graph, from: AttemptId, to: AttemptId, text: Schema.String },
  /** Journal the single automatic Continue; replay consumes its durable marker. */
  AttemptRecoveryContinued: {
    ...attempt,
    turnId: TurnId,
    interruptionId: Schema.String,
    cause: Schema.Literal("recover"),
  },
};

export const ConstellationEvent = Schema.TaggedUnion(constellationEventFields);

export type ConstellationEvent = typeof ConstellationEvent.Type;

export const resourceEventFields = {
  ResourceDeclared: { resource: HostResource },
  ResourceRemoved: { hostId: HostId, resource: Schema.String },
  ResourceLeaseCanceled: {
    hostId: HostId,
    resource: Schema.String,
    requestId: Schema.String,
    reason: Schema.String,
  },
  ResourceLeaseQueued: {
    hostId: HostId,
    resource: Schema.String,
    requestId: Schema.String,
    sessionId: optionalNullable(SessionId),
    processId: Schema.optionalKey(Schema.Int),
    processIdentity: Schema.optionalKey(Schema.String),
    command: Schema.optionalKey(Schema.Array(Schema.String)),
    attemptId: optionalNullable(AttemptId),
  },
  ResourceLeased: { lease: ResourceLease },
  ResourceReleased: {
    hostId: HostId,
    leaseId: Schema.String,
    resource: Schema.String,
    reason: Schema.String,
  },
};

export const ResourceEvent = Schema.TaggedUnion(resourceEventFields);

export type ResourceEvent = typeof ResourceEvent.Type;

/** Durable remote requests retain their id when the Desktop App retries delivery. */
export class ConstellationOutboxEntry extends Schema.Class<ConstellationOutboxEntry>(
  "ConstellationOutboxEntry"
)({
  id: Schema.NonEmptyString,
  constellationId: ConstellationId,
  ownerHostId: HostId,
  workerHostId: HostId,
  sessionId: SessionId,
  attemptId: AttemptId,
  command: Schema.Union([
    ConstellationCommand.cases.WorkerBlock,
    ConstellationCommand.cases.WorkerClaim,
    ConstellationCommand.cases.WorkerAsk,
    ConstellationCommand.cases.WorkerProgress,
    ConstellationCommand.cases.WorkerPropose,
    ConstellationCommand.cases.WorkerMessage,
  ]),
}) {}
