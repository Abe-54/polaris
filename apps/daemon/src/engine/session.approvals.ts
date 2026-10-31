/** Approval rules the Session machine applies: Secret Requests' decisions, and withdrawals. */
import { ApprovalDecision, DomainEvent, type RequestId } from "@polaris/protocol";
import type { SessionRecord } from "../store/model.ts";
import { workingTurn } from "../store/model.ts";

/** Why `decision` can't answer the pending request, or null when it can. */
export const decisionRefusal = (
  record: SessionRecord,
  requestId: RequestId,
  decision: ApprovalDecision
): string | null => {
  const request = record.pending.get(requestId);
  const secret = request?.kind === "secret";
  const data = request?.dataSource !== undefined;

  return ApprovalDecision.match(decision, {
    Allow: () => (secret ? "a Secret Request takes a secret or a decline" : null),
    Answer: () =>
      data
        ? "a Data Source Approval takes an allow or a deny"
        : secret
          ? "a Secret Request takes a secret or a decline"
          : null,
    Deny: () => null,
    Provided: () => (secret ? null : `request ${requestId} is not a Secret Request`),
  });
};

/** Back to Working once nothing is pending, but only with a Turn to work on. */
export const backToWork = (record: SessionRecord, closing: RequestId) =>
  record.pending.size === 1 && record.pending.has(closing) && workingTurn(record) !== undefined
    ? ({ state: "working" } as const)
    : undefined;

export interface Withdrawal {
  readonly requestId: RequestId;
  /** The Daemon withdraws a Secret Request that timed out. */
  readonly withdrawnBy: "harness" | "daemon";
  readonly reason: string;
}

export const withdrawn = (record: SessionRecord, withdrawal: Withdrawal) =>
  DomainEvent.cases.ApprovalWithdrawn.make({
    sessionId: record.session.id,
    requestId: withdrawal.requestId,
    withdrawnBy: withdrawal.withdrawnBy,
    reason: withdrawal.reason,
  });

/** Only the Daemon may request Data access; the same pending target shares one card. */
export const canRequestDataApproval = (
  record: SessionRecord,
  event: { type: string; request: import("@polaris/protocol").ApprovalRequest }
) => {
  const target = event.request.dataSource;

  if (event.type === "harness.approvalRequested") return target === undefined;

  if (target === undefined) return false;

  const key = (value: typeof target) =>
    JSON.stringify([
      value.sourceId,
      value.engine,
      value.host,
      value.port,
      value.database,
      value.user,
    ]);

  return ![...record.pending.values()].some(
    (request) => request.dataSource !== undefined && key(request.dataSource) === key(target)
  );
};
