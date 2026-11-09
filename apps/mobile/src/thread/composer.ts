/**
 * What the composer does in each Session State, mirroring the Desktop App's
 * composer (and so the session machine): send a Turn, steer the Turn in
 * flight, queue a follow-up for after it, answer an open question, or nothing.
 */
import {
  type ApprovalRequest,
  ApprovalDecision,
  type Attachment,
  type AttachmentId,
  Command,
  type RequestId,
  type SessionId,
  type SessionState,
  type TurnStatus,
} from "@polaris/protocol";

export type ComposerMode =
  | { readonly kind: "send" }
  /** Send steers the Turn in flight; Queue holds the text for after it. */
  | { readonly kind: "steer" }
  /** A Turn is in flight and can't be steered: Send queues a follow-up. */
  | { readonly kind: "queue" }
  | { readonly kind: "answer"; readonly requestId: RequestId }
  | { readonly kind: "blocked"; readonly reason: string };

export interface ComposerContext {
  readonly state: SessionState;
  readonly lastTurn: TurnStatus | null;
  readonly pendingApprovals: ReadonlyArray<ApprovalRequest>;
  /** The Daemon has `session.steer`. */
  readonly canSteer: boolean;
}

const blocked = (reason: string): ComposerMode => ({ kind: "blocked", reason });

const ANSWER_FIRST = "Answer the request above to go on";

/** The first open question, when every open request is a question. */
const openQuestion = (pending: ReadonlyArray<ApprovalRequest>): RequestId | null =>
  pending.length > 0 && pending.every((r) => r.kind === "question")
    ? (pending[0]?.id ?? null)
    : null;

export const composerMode = (ctx: ComposerContext): ComposerMode => {
  if (ctx.state === "archived") return blocked("Unarchive this session to send a turn");

  if (ctx.state === "in-terminal") return blocked("In terminal · take it back to send a turn");
  const question = openQuestion(ctx.pendingApprovals);

  if (question !== null) return { kind: "answer", requestId: question };

  if (ctx.lastTurn === "working") {
    if (ctx.pendingApprovals.length > 0) return blocked(ANSWER_FIRST);

    return ctx.canSteer ? { kind: "steer" } : { kind: "queue" };
  }

  if (ctx.state === "starting") return blocked("Starting…");

  if (ctx.state === "needs-you" && ctx.pendingApprovals.length > 0) return blocked(ANSWER_FIRST);

  return { kind: "send" };
};

const PLACEHOLDERS = {
  send: "Ask for a change",
  steer: "Steer this turn",
  queue: "Queue a follow-up for after this turn",
  answer: "Or answer in your own words",
} as const;

export const placeholderFor = (mode: ComposerMode): string =>
  mode.kind === "blocked" ? mode.reason : PLACEHOLDERS[mode.kind];

/** While a Turn runs, the text can wait for it as a follow-up. */
export const canQueue = (mode: ComposerMode) => mode.kind === "steer" || mode.kind === "queue";

/**
 * A draft with attachments steers only where the Host and Harness take them
 * (`steersAttachments`); otherwise it waits for the next Turn instead.
 */
export const sendQueues = (
  mode: ComposerMode,
  attachments: ReadonlyArray<AttachmentId>,
  steersAttachments = false
) =>
  mode.kind === "queue" || (mode.kind === "steer" && attachments.length > 0 && !steersAttachments);

/** The command Send makes of the text; null when it queues instead or there's nothing to send. */
export const submitCommand = (
  mode: ComposerMode,
  sessionId: SessionId,
  draft: string,
  attachments: ReadonlyArray<AttachmentId> = [],
  steersAttachments = false
): Command | null => {
  const text = draft.trim();

  if (text === "" || mode.kind === "blocked" || sendQueues(mode, attachments, steersAttachments))
    return null;

  if (mode.kind === "steer")
    return Command.cases.Steer.make(
      attachments.length === 0
        ? { sessionId, text }
        : { sessionId, text, attachments: [...attachments] }
    );

  if (mode.kind === "answer")
    return Command.cases.RespondToApproval.make({
      sessionId,
      requestId: mode.requestId,
      decision: ApprovalDecision.cases.Answer.make({ text }),
    });

  return Command.cases.SendTurn.make({ sessionId, prompt: text, attachments: [...attachments] });
};

/** A follow-up the composer holds until the Turn in flight ends. */
export interface FollowUp {
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
}

/** A held follow-up, sent as a Turn once the one in flight ends. */
export const followUpCommand = (sessionId: SessionId, followUp: FollowUp): Command =>
  Command.cases.SendTurn.make({
    sessionId,
    prompt: followUp.text.trim(),
    attachments: followUp.attachments.map((attachment) => attachment.id),
  });
