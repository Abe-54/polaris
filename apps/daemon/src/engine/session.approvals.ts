/** Approval rules the Session machine applies: Secret Requests' decisions, and withdrawals. */
import {
  type Actor,
  appDecisionRefusal,
  ApprovalDecision,
  DomainEvent,
  type ApprovalRequest,
  type RequestId,
} from "@polaris/protocol";
import type { SessionRecord } from "../store/model.ts";
import { workingTurn } from "../store/model.ts";

/** Why a text Answer can't close `request`, or null when it can. */
const answerRefusal = (request: ApprovalRequest | undefined) => {
  if (request?.profileAttach !== undefined)
    return "an inspector attach takes an allow once or a deny";

  if (request?.dataSource !== undefined || request?.dataWrite !== undefined)
    return "a Data Source Approval takes an allow or a deny";

  if (request?.origin !== undefined) return "an Origin Approval takes an allow or a deny";

  return request?.kind === "secret" ? "a Secret Request takes a secret or a decline" : null;
};

/** Why `decision` can't answer the pending request, or null when it can. */
export const decisionRefusal = (
  record: SessionRecord,
  requestId: RequestId,
  decision: ApprovalDecision,
  actor: Actor | null = null
): string | null => {
  const request = record.pending.get(requestId);
  // Computer use (ADR 0104): never always for headed input, nor from an Extension.
  const app = request === undefined ? null : appDecisionRefusal(request.kind, decision, actor);

  if (app !== null) return app;
  const secret = request?.kind === "secret";
  const attach = request?.profileAttach !== undefined;

  return ApprovalDecision.match(decision, {
    Allow: (allow) => {
      if (allow.originScope !== undefined && request?.origin === undefined)
        return "only an Origin Approval takes an origin scope";

      if (attach && (allow.remember || allow.dataScope !== undefined))
        return "an inspector attach requires a new approval every time";

      return secret ? "a Secret Request takes a secret or a decline" : null;
    },
    Answer: () => answerRefusal(request),
    Deny: () => null,
    Provided: () => (secret ? null : `request ${requestId} is not a Secret Request`),
  });
};

/** The two kinds computer use opens: Polaris answers its own waiting tool call, never the Harness. */
export const isAppApproval = (request: Pick<ApprovalRequest, "kind">) =>
  request.kind === "app" || request.kind === "headed-input";

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

/** Requests only the Daemon raises and answers itself: never forwarded to a Harness. */
export const daemonOwned = (
  request: Pick<ApprovalRequest, "dataSource" | "dataWrite" | "origin" | "profileAttach">
) =>
  request.dataSource !== undefined ||
  request.dataWrite !== undefined ||
  request.origin !== undefined ||
  request.profileAttach !== undefined;

/** One card per origin across the Session's pending requests (ADR 0098). */
const originPending = (record: SessionRecord, origin: string) =>
  [...record.pending.values()].some((request) => request.origin?.origin === origin);

/** Only the Daemon may request Data or origin access; the same pending target shares one card. */
export const canRequestDataApproval = (
  record: SessionRecord,
  event: { type: string; request: ApprovalRequest }
) => {
  const target = event.request.dataSource;

  const write = event.request.dataWrite;

  const attach = event.request.profileAttach;

  const origin = event.request.origin;

  if (event.type === "inspector.approvalRequested")
    return (
      attach !== undefined && target === undefined && write === undefined && origin === undefined
    );

  if (attach !== undefined) return false;

  if (event.type === "harness.approvalRequested") return !daemonOwned(event.request);

  if (origin !== undefined)
    return target === undefined && write === undefined && !originPending(record, origin.origin);

  if (write !== undefined)
    return (
      target === undefined &&
      ![...record.pending.values()].some(
        (request) => request.dataWrite?.fingerprint === write.fingerprint
      )
    );

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

/** An upgrade leaves the terminal Harness alive, but its Daemon-owned approval waiters are gone. */
export const withdrawDaemonApprovals = (record: SessionRecord) =>
  [...record.pending.values()].flatMap((request) =>
    !daemonOwned(request)
      ? []
      : [
          withdrawn(record, {
            requestId: request.id,
            withdrawnBy: "daemon",
            reason: "The Daemon restarted during this approval.",
          }),
        ]
  );
