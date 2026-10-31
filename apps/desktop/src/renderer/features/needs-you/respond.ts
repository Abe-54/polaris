/**
 * Answering from the inbox, hover cards and notifications: RespondToApproval, Continue, Retry
 * and Take back, dispatched like the conversation does, with the refusal shown as a toast.
 */
import type { ApprovalDecision, ApprovalRequest, RequestId, SessionId } from "@polaris/protocol";
import { Commands, Decisions } from "../../commands.ts";
import { allowFor, forgetDecision, noteDecision, noteGrant } from "../data/approval/decide.ts";
import { askDenyReason } from "../data/write/deny.ts";
import { send } from "../session/dispatch.ts";
import { markAnswered } from "./answered.ts";

export interface RespondInput {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly requestId: string;
  readonly decision: ApprovalDecision;
}

export const respond = async ({ hostKey, sessionId, requestId, decision }: RespondInput) => {
  markAnswered(requestId);

  return send(
    hostKey,
    Commands.RespondToApproval({
      sessionId,
      // SAFETY: request ids come from the Daemon's ApprovalRequested events.
      requestId: requestId as RequestId,
      decision,
    }),
    "Couldn't answer"
  );
};

/** An approval as the inbox, hover cards and notifications hold it. */
export interface ApprovalTarget {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly request: ApprovalRequest;
}

/** Answers `request`, recording a Data Source Approval's decision for every view of it. */
export const decide = async (
  { hostKey, sessionId, request }: ApprovalTarget,
  decision: ApprovalDecision
) => {
  noteDecision(request, decision);
  const sent = await respond({ hostKey, sessionId, requestId: request.id, decision });

  if (sent) noteGrant(hostKey, request, decision);
  else forgetDecision(request.id);

  return sent;
};

/** A Data Source Approval sends its card's scope, remembered, whatever `remember` says. */
export const approve = (target: ApprovalTarget, remember = false) =>
  decide(target, allowFor(target.request, remember));

/**
 * A write is never denied blind: `open` shows its session, where the card's reason field opens,
 * as the agent needs the why.
 */
export const deny = async (target: ApprovalTarget, open?: () => void) => {
  if (target.request.dataWrite === undefined)
    return decide(target, Decisions.Deny({ reason: null }));
  open?.();
  askDenyReason(target.request.id);

  return false;
};

export const answer = (input: Omit<RespondInput, "decision">, text: string) =>
  respond({ ...input, decision: Decisions.Answer({ text }) });

/** An Interrupted Turn after a restart: pick it up where it stopped. */
export const continueTurn = (hostKey: string, sessionId: SessionId) =>
  send(hostKey, Commands.Continue({ sessionId }), "Couldn't continue");

/** A Failed Turn: send its prompt again as a new Turn. */
export const retryTurn = (hostKey: string, sessionId: SessionId) =>
  send(hostKey, Commands.Retry({ sessionId }), "Couldn't retry");

/** In Terminal: hand the session back to Polaris. */
export const takeBack = (hostKey: string, sessionId: SessionId) =>
  send(hostKey, Commands.ReturnFromTerminal({ sessionId }), "Couldn't take it back");
