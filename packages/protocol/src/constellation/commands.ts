import { Schema } from "effect";
import { HostId, SessionId, Timestamp, WorkspaceId } from "../ids.ts";
import { optionalArray, optionalNullable } from "../models.ts";
import {
  AttemptId,
  CheckReceipt,
  Claim,
  ConstellationId,
  ConstellationQuestion,
  ConstellationSettings,
  HarnessSelection,
  HostResource,
  Revision,
  TaskDefinition,
  TaskId,
} from "./domain.ts";

/**
 * A worker's declared wait on its own background work (the `wait` tool, ENG-742): it holds
 * off nudges and stall audits until `until`, or until its next Turn or Claim.
 */
export const AttemptWaiting = Schema.Struct({
  on: Schema.NonEmptyString,
  until: Timestamp,
});

export type AttemptWaiting = typeof AttemptWaiting.Type;

export const PlanOperation = Schema.TaggedUnion({
  Add: { task: TaskDefinition },
  Edit: { taskId: TaskId, revision: Revision, task: TaskDefinition },
  Cancel: { taskId: TaskId, revision: Revision },
});

export type PlanOperation = typeof PlanOperation.Type;

export const WorkerPlacement = Schema.TaggedUnion({
  New: {
    hostId: HostId,
    selection: optionalNullable(HarnessSelection),
    base: optionalNullable(Schema.String),
    worktree: optionalNullable(Schema.String),
    branch: optionalNullable(Schema.String),
  },
  Existing: { sessionId: SessionId },
});

export type WorkerPlacement = typeof WorkerPlacement.Type;

export const MessageTarget = Schema.TaggedUnion({
  Lead: {},
  Worker: { attemptId: AttemptId },
  All: {},
});

export type MessageTarget = typeof MessageTarget.Type;

export const MessageAuthority = Schema.Literals([
  "conversation",
  "recommend_and_return",
  "may_decide_and_continue",
]);

export type MessageAuthority = typeof MessageAuthority.Type;

export const ReviewAction = Schema.TaggedUnion({
  Approve: {},
  HandUp: { reason: optionalNullable(Schema.String) },
  Accept: { mergedHead: Schema.NonEmptyString, receipts: Schema.Array(CheckReceipt) },
  SendBack: {
    reason: Schema.NonEmptyString,
    worker: WorkerPlacement,
    mergeConflictBase: optionalNullable(Schema.String),
  },
  Stop: { reason: Schema.NonEmptyString },
});

export type ReviewAction = typeof ReviewAction.Type;

export const AnswerAction = Schema.TaggedUnion({
  Proposal: { proposalId: Schema.NonEmptyString, accept: Schema.Boolean, reason: Schema.String },
  Question: { attemptId: AttemptId, questionId: Schema.NonEmptyString, text: Schema.String },
});

export type AnswerAction = typeof AnswerAction.Type;

export const SetConstellationStateAction = Schema.TaggedUnion({
  Pause: {},
  Resume: {},
  Complete: {},
  Archive: {},
  HandOver: {
    summary: Schema.String,
    interrupt: Schema.Boolean,
    selection: optionalNullable(HarnessSelection),
  },
});

export type SetConstellationStateAction = typeof SetConstellationStateAction.Type;

/** Role is derived from the authenticated session binding, never from command input. */
export const ConstellationCommand = Schema.TaggedUnion({
  Plan: {
    constellationId: ConstellationId,
    start: Schema.optionalKey(
      Schema.Struct({
        name: Schema.NonEmptyString,
        workspaceId: WorkspaceId,
        leadSessionId: SessionId,
        settings: Schema.optionalKey(ConstellationSettings),
      })
    ),
    operations: Schema.Array(PlanOperation),
    resources: optionalArray(HostResource),
  },
  Dispatch: {
    constellationId: ConstellationId,
    tasks: optionalArray(Schema.Struct({ taskId: TaskId, worker: WorkerPlacement })),
    defaultWorker: optionalNullable(WorkerPlacement),
  },
  Review: {
    constellationId: ConstellationId,
    attemptId: AttemptId,
    revision: Revision,
    action: ReviewAction,
  },
  Answer: { constellationId: ConstellationId, action: AnswerAction },
  Message: {
    constellationId: ConstellationId,
    target: MessageTarget,
    text: Schema.NonEmptyString,
    authority: Schema.optionalKey(MessageAuthority),
  },
  SetState: { constellationId: ConstellationId, action: SetConstellationStateAction },
  WorkerBlock: {
    constellationId: ConstellationId,
    attemptId: AttemptId,
    on: Schema.Array(TaskId),
    reason: Schema.NonEmptyString,
  },
  WorkerClaim: { constellationId: ConstellationId, attemptId: AttemptId, claim: Claim },
  WorkerAsk: {
    constellationId: ConstellationId,
    attemptId: AttemptId,
    question: ConstellationQuestion,
  },
  WorkerProgress: {
    constellationId: ConstellationId,
    attemptId: AttemptId,
    note: Schema.String,
    completed: optionalNullable(Revision),
    total: optionalNullable(Revision),
    waiting: optionalNullable(AttemptWaiting),
  },
  WorkerPropose: { constellationId: ConstellationId, attemptId: AttemptId, task: TaskDefinition },
  WorkerMessage: {
    constellationId: ConstellationId,
    attemptId: AttemptId,
    to: TaskId,
    text: Schema.NonEmptyString,
  },
});

export type ConstellationCommand = typeof ConstellationCommand.Type;
