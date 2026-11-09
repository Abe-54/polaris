/** Origin Approvals as the send engine's pre-send hook for agents' Sends (ADR 0098). */
import type { RequestId } from "@polaris/protocol";
import { Context, Effect } from "effect";
import { RequestSends, type PendingSend, type PreSendHook } from "../sendsService.ts";
import { OriginApprovals, type AgentSend } from "./service.ts";

/** The Origin Approval an earlier attempt of this Send waited on; the retry spends its grant. */
export class OriginGrant extends Context.Reference<RequestId | null>(
  "polaris/requests/OriginGrant",
  { defaultValue: () => null }
) {}

/** The real origin with the masked path, so the card never shows a secret. */
const agentSend = (send: PendingSend): AgentSend => {
  const variable = send.variables.find((resolved) => resolved.origin !== undefined)?.name;

  return {
    url: send.origin === "" ? send.url : `${send.origin}${send.path}`,
    method: send.method,
    ...(variable === undefined ? undefined : { variable }),
    ...(send.environment === undefined ? undefined : { environment: send.environment }),
  };
};

/**
 * Local Origins pass; Remote Origins need a remembered rule or an approved grant, else the
 * Send is held on an Origin Approval. A denied grant (or reads scope for a write) denies it.
 */
export const originGate =
  (approvals: OriginApprovals["Service"]): PreSendHook =>
  (send) =>
    Effect.gen(function* () {
      const grant = yield* OriginGrant;

      if (grant !== null) {
        const answer = yield* approvals.awaitApproval(grant, send.write, 0);

        if (answer.status === "denied") return { allow: false, message: answer.reason } as const;
      }

      yield* approvals.require(
        send.by.sessionId,
        agentSend(send),
        grant === null ? { turn: send.by.turn } : { turn: send.by.turn, approvalId: grant }
      );

      return { allow: true } as const;
    });

/** Gates every agent Send with Origin Approvals until the scope closes. */
export const registerOriginGate = Effect.gen(function* () {
  const sends = yield* RequestSends;
  const approvals = yield* OriginApprovals;
  yield* sends.registerPreSend(originGate(approvals));
});
