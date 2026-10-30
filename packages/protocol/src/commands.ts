/**
 * Commands a Client dispatches to a Daemon. Each carries a Client-chosen
 * `commandId`; the Daemon stores a receipt so a retried command is applied once.
 * An ack means "intent recorded", not "the Harness finished".
 */
import { WorktreeSetup } from "./worktreeSetup.ts";
import { Schema } from "effect";
import { ApprovalDecision, PermissionMode, SessionOrigin } from "./domain.ts";
import { HarnessKind } from "./harnesses.ts";
import {
  AttachmentId,
  RequestId,
  ReviewCheckoutId,
  RiskFindingId,
  RiskSummaryId,
  SessionId,
  TurnId,
  VerdictId,
  WorkspaceId,
} from "./ids.ts";
import { addedNullable, ServiceTier, ModelId, ReasoningEffort } from "./models.ts";
import {
  FeedbackBatch,
  PullRequestRef,
  ReviewSubject,
  VerdictReason,
  VerdictScope,
  VerdictThumb,
} from "./review.ts";

export const SessionPlacement = Schema.TaggedUnion({
  /** Work directly in the Workspace directory (the default). */
  InPlace: {},
  /** Create a new Worktree at `<worktreeRoot>/<branch>`. */
  NewWorktree: { branch: Schema.String, baseRef: Schema.NullOr(Schema.String) },
  /** Use a Worktree that already exists. */
  ExistingWorktree: { path: Schema.String },
  /** Work in a Review Checkout: the Reviewer's own read-only session (capability `review.risk-summary`). */
  ReviewCheckout: { checkoutId: ReviewCheckoutId },
});

export type SessionPlacement = typeof SessionPlacement.Type;

export const Command = Schema.TaggedUnion({
  RegisterWorkspace: { path: Schema.String, name: Schema.NullOr(Schema.String) },
  SetWorktreeSetup: { workspaceId: WorkspaceId, setup: Schema.NullOr(WorktreeSetup) },
  SetWorkspaceHidden: { workspaceId: WorkspaceId, hidden: Schema.Boolean },
  RemoveWorkspace: { workspaceId: WorkspaceId },

  StartSession: {
    sessionId: SessionId,
    workspaceId: WorkspaceId,
    harness: HarnessKind,
    placement: SessionPlacement,
    permissionMode: PermissionMode,
    /** The initial Model and effort; null for the Harness's and the Model's defaults. */
    model: Schema.NullOr(ModelId),
    effort: addedNullable(ReasoningEffort),
    serviceTier: Schema.optionalKey(Schema.NullOr(ServiceTier)),
    prompt: Schema.String,
    attachments: Schema.Array(AttachmentId),
    /** Set by the Daemon's Reviewer and walkthrough; never by a Client. */
    origin: Schema.optionalKey(Schema.NullOr(SessionOrigin)),
  },
  SendTurn: {
    sessionId: SessionId,
    prompt: Schema.String,
    attachments: Schema.Array(AttachmentId),
  },
  /**
   * Run `command` in the session's directory as a new Turn (capability `session.shell-command`,
   * where the Harness `runsShellCommands`): the Daemon runs it, then the agent reads its output.
   */
  RunShellCommand: { sessionId: SessionId, command: Schema.String },
  /**
   * Compact an Idle or Dormant session's context window, as a Turn marked `idleCompaction`
   * (capability `sessions.idle-compaction`). The Daemon's idle compaction sends it.
   */
  CompactSession: { sessionId: SessionId },
  /**
   * Add guidance to the Turn in flight without interrupting it, where the Harness supports it.
   * `attachments` need capability `session.steer-attachments` and a Harness whose
   * `HarnessModels.steersAttachments` is true; otherwise a Client queues the draft as a follow-up.
   */
  Steer: {
    sessionId: SessionId,
    text: Schema.String,
    attachments: Schema.optionalKey(Schema.Array(AttachmentId)),
  },
  Interrupt: { sessionId: SessionId },
  /**
   * Stop background work that outlived its Turn (`AgentSession.backgroundTasks`): the
   * tasks named, or every one when null (capability `session.stop-background`).
   */
  StopBackgroundTasks: {
    sessionId: SessionId,
    taskIds: Schema.NullOr(Schema.Array(Schema.String)),
  },
  /**
   * Move a command the Turn is waiting on into the background, as Ctrl-B does in Claude
   * Code: the one item named, or every one when null (capability `session.background-command`).
   */
  BackgroundCommand: { sessionId: SessionId, itemId: Schema.NullOr(Schema.String) },
  /** Continue an Interrupted Turn after a Daemon restart. Never done automatically. */
  Continue: { sessionId: SessionId },
  /** Send a Failed Turn's prompt and attachments again, as a new Turn. */
  Retry: { sessionId: SessionId },
  RespondToApproval: {
    sessionId: SessionId,
    requestId: RequestId,
    decision: ApprovalDecision,
  },
  RenameSession: { sessionId: SessionId, title: Schema.String },
  /** Pin the session to the top of the list, or unpin it (capability `session.pin`). */
  PinSession: { sessionId: SessionId, pinned: Schema.Boolean },
  /** Continue the session on its own when its usage limit resets (capability `session.limited`). */
  SetResumeAtReset: { sessionId: SessionId, resumeAtReset: Schema.Boolean },
  SetPermissionMode: { sessionId: SessionId, permissionMode: PermissionMode },
  /**
   * The Model and effort for the next Turns (capability `session.set-model`).
   * Only between Turns, and only where the Harness can switch Model mid-session;
   * otherwise fork with the new Model.
   */
  SetModel: {
    sessionId: SessionId,
    model: Schema.NullOr(ModelId),
    effort: Schema.NullOr(ReasoningEffort),
    serviceTier: Schema.optionalKey(Schema.NullOr(ServiceTier)),
  },
  ForkSession: {
    sessionId: SessionId,
    fromSessionId: SessionId,
    fromTurnId: TurnId,
    harness: HarnessKind,
    /** Null keeps the parent's Model and effort for the same Harness, else the defaults. */
    model: addedNullable(ModelId),
    effort: addedNullable(ReasoningEffort),
    serviceTier: Schema.optionalKey(Schema.NullOr(ServiceTier)),
  },
  /** Archive removes the session's Worktree but keeps its branch; unmerged branches are never deleted. */
  ArchiveSession: { sessionId: SessionId, deleteMergedBranch: Schema.Boolean },
  UnarchiveSession: { sessionId: SessionId },
  /** Hand the session to the Harness's own terminal UI (In Terminal). */
  OpenInTerminal: { sessionId: SessionId },
  /** Take the session back from the terminal UI. */
  ReturnFromTerminal: { sessionId: SessionId },

  // ── Review (protocol README, "Review") ──

  /**
   * Send a Review's feedback batch as one Turn (capability `session.feedback`):
   * accepted where `SendTurn` is, with `feedbackPrompt(feedback)` as its prompt.
   */
  SendFeedback: {
    sessionId: SessionId,
    feedback: FeedbackBatch,
    attachments: Schema.Array(AttachmentId),
  },
  /**
   * Accept the session's Turns through `throughTurnId`, a contiguous prefix
   * (capability `session.accept`). Refused with a Turn in flight or for a Turn
   * before one already accepted. `revertLaterTurns` restores the working tree
   * to that Turn's after-checkpoint, undoing the Turns after it.
   */
  AcceptTurns: { sessionId: SessionId, throughTurnId: TurnId, revertLaterTurns: Schema.Boolean },
  /** The pull request the accepted work was opened as; it archives the session once merged. */
  LinkPullRequest: { sessionId: SessionId, pullRequest: PullRequestRef },

  /**
   * Open a Review Checkout (capability `review.checkouts`). `head` and `base`
   * are the code host's commits for a pull request; null for Agent Session
   * Turns, whose checkpoints the Daemon reads.
   */
  OpenReviewCheckout: {
    checkoutId: ReviewCheckoutId,
    workspaceId: WorkspaceId,
    subject: ReviewSubject,
    head: Schema.NullOr(Schema.String),
    base: Schema.NullOr(Schema.String),
  },
  /** The code host reports the pull request's current head and base; a new head makes it stale. */
  ReportReviewHead: { checkoutId: ReviewCheckoutId, head: Schema.String, base: Schema.String },
  /** Move the checkout to the latest head. `discardChanges` drops local edits first. */
  UpdateReviewCheckout: { checkoutId: ReviewCheckoutId, discardChanges: Schema.Boolean },
  /** Remove it: the pull request merged or closed (the Client detects it), or the user asked. */
  RemoveReviewCheckout: {
    checkoutId: ReviewCheckoutId,
    reason: Schema.Literals(["merged", "closed", "user"]),
  },
  /** A thumbs-up or thumbs-down on a Risk Finding (capability `review.verdicts`). */
  RecordVerdict: {
    verdictId: VerdictId,
    summaryId: RiskSummaryId,
    findingId: RiskFindingId,
    thumb: VerdictThumb,
    reasons: Schema.Array(VerdictReason),
    text: Schema.NullOr(Schema.String),
    scope: VerdictScope,
  },
});

export type Command = typeof Command.Type;
