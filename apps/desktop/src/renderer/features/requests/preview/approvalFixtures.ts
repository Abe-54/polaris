/**
 * Origin Approvals for previews and tests (Paper Q3): "Fix overdue totals" asking to POST to
 * staging.ledger.dev, its URL from `{{base}}` in env staging and its token from .env.local.
 */
import {
  type ApprovalRequest,
  OriginApproval,
  RequestId,
  type SessionId,
  TurnId,
} from "@polaris/protocol";
import type { AppState } from "../../../store/store.ts";

export const STAGING_POST = new OriginApproval({
  origin: "https://staging.ledger.dev:443",
  variable: "base",
  environment: "staging",
  method: "POST",
  path: "/invoices/overdue",
  write: true,
  tokenSource: { file: ".env.local", name: "LEDGER_TOKEN" },
});

export const STAGING_GET = new OriginApproval({
  origin: "https://staging.ledger.dev:443",
  method: "GET",
  path: "/invoices/overdue",
  write: false,
});

export const fixtureOriginApproval = (
  sessionId: SessionId,
  id: string,
  origin: OriginApproval = STAGING_POST,
  openedAt = "2026-11-09T14:20:00.000Z"
): ApprovalRequest => ({
  id: RequestId.make(id),
  sessionId,
  turnId: TurnId.make("t-12"),
  kind: "tool",
  title: `Send to ${origin.origin}`,
  detail: null,
  options: [],
  questions: [],
  placeholder: null,
  expiresAt: null,
  openedAt,
  origin,
});

/** `state` with `pending` waiting in `sessionId` on `hostKey`. */
export const withPendingApprovals = (
  state: AppState,
  hostKey: string,
  sessionId: string,
  pending: ReadonlyArray<ApprovalRequest>
): AppState => {
  const model = state.hostModels[hostKey];
  const entry = model?.sessions.get(sessionId);

  if (model === undefined || entry === undefined) return state;

  return {
    ...state,
    hostModels: {
      ...state.hostModels,
      [hostKey]: {
        ...model,
        sessions: new Map([
          ...model.sessions,
          [sessionId, { ...entry, pendingApprovals: pending }],
        ]),
      },
    },
  };
};
