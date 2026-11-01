/** Answering an approval from Home: the decision as a `RespondToApproval` command. */
import type { DaemonClient } from "@polaris/client/rpc";
import { ApprovalDecision, type ApprovalRequest, Command, CommandId } from "@polaris/protocol";
import { Effect, Match } from "effect";
import { tracedDispatch } from "../../selfTraces/index.ts";

export type Reply =
  | { readonly kind: "approve" }
  | { readonly kind: "always" }
  | { readonly kind: "deny" }
  /** A chosen option, or the user's own words. */
  | { readonly kind: "answer"; readonly text: string };

export const decisionOf = (reply: Reply): ApprovalDecision =>
  Match.value(reply).pipe(
    Match.discriminatorsExhaustive("kind")({
      approve: () => ApprovalDecision.cases.Allow.make({ remember: false }),
      always: () => ApprovalDecision.cases.Allow.make({ remember: true }),
      deny: () => ApprovalDecision.cases.Deny.make({ reason: null }),
      answer: ({ text }) => ApprovalDecision.cases.Answer.make({ text, answers: [[text]] }),
    })
  );

const hex = (count: number) =>
  Array.from({ length: count }, () => Math.floor(Math.random() * 16).toString(16)).join("");

/** Each tap is its own command; a retried dispatch of the same id is answered once. */
export const newCommandId = (): CommandId =>
  CommandId.make(`mobile-${Date.now().toString(16)}-${hex(16)}`);

export const respondCommand = (approval: ApprovalRequest, reply: Reply): Command =>
  Command.cases.RespondToApproval.make({
    sessionId: approval.sessionId,
    requestId: approval.id,
    decision: decisionOf(reply),
  });

export const respond = (
  client: DaemonClient,
  approval: ApprovalRequest,
  reply: Reply,
  commandId: CommandId = newCommandId()
) => {
  const command = respondCommand(approval, reply);

  return tracedDispatch(command, commandId, Effect.asVoid(client.dispatch({ commandId, command })));
};
