/**
 * Answers from the Live Activity's takeover. Its LiveActivityIntent runs in the app and hands
 * `{hostId, sessionId, requestId, line, decision}` to JS, which sends it as a notification's
 * answer once that Host's own feed confirms the request: any linked Host can seal a slice.
 */
import { ApprovalDecision, Command, CommandId, RequestId, SessionId } from "@polaris/protocol";
import { Schema } from "effect";
import type { HostFeedState } from "../home/feed/fold.ts";
import type { Answer } from "../push/answer.ts";

export const LiveAnswer = Schema.Struct({
  hostId: Schema.String,
  sessionId: SessionId,
  requestId: RequestId,
  /** The request's line as the takeover showed it, whole: a cut line is answered in the app. */
  line: Schema.String,
  decision: Schema.Literals(["approve", "always", "deny"]),
});

export type LiveAnswer = typeof LiveAnswer.Type;

/** What `takeAnswers` hands over; None for anything the intent didn't send. */
export const decodeLiveAnswer = Schema.decodeUnknownOption(LiveAnswer);

const DECISIONS = {
  approve: ApprovalDecision.cases.Allow.make({ remember: false }),
  always: ApprovalDecision.cases.Allow.make({ remember: true }),
  deny: ApprovalDecision.cases.Deny.make({ reason: null }),
} as const;

/**
 * Whether `feed`, from the Host the answer names, has that request open in that session with
 * the line the user saw. A slice from another Host can't steer an answer to this one.
 */
export const confirmedBy = (feed: HostFeedState, answer: LiveAnswer): boolean => {
  const request = feed.sessions
    .get(answer.sessionId)
    ?.pendingApprovals.find((pending) => pending.id === answer.requestId);

  // Exact: a prefix match would let a forged "…" stand for any request. A secret is never decided.
  return (
    request !== undefined &&
    request.kind !== "secret" &&
    request.profileAttach === undefined &&
    request.title === answer.line
  );
};

/** The id the module's `answered` takes to let the intent return. */
export const liveAnswerId = (answer: Answer & { readonly requestId: string }) =>
  `${answer.hostId}:${answer.requestId}`;

export const liveAnswerOf = ({
  hostId,
  sessionId,
  requestId,
  decision,
}: LiveAnswer): Answer & { readonly requestId: string } => ({
  hostId,
  requestId,
  dispatch: {
    // The notification's id for the same request: answered from both, it's one answer.
    commandId: CommandId.make(`push-answer:${hostId}:${requestId}`),
    command: Command.cases.RespondToApproval.make({
      sessionId,
      requestId,
      decision: DECISIONS[decision],
    }),
  },
});
