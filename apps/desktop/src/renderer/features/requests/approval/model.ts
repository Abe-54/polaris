/**
 * The Origin Approval (DESIGN.md, Requests → States; Paper Q3): an agent's Send to a Remote
 * Origin, the rows Approve covers, and the scope pre-selected to what the waiting Send needs. Pure.
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  OriginApproval,
  OriginScope,
} from "@polaris/protocol";
import { Decisions } from "../../../commands.ts";

/** `https://staging.ledger.dev:443` as people write it: the default port left out. */
export const shownOrigin = (origin: string) => {
  try {
    const url = new URL(origin);

    // URL drops a scheme's default port from `host`.
    return `${url.protocol}//${url.host}`;
  } catch {
    return origin;
  }
};

/** "staging.ledger.dev": the host the title names. */
export const originHost = (origin: string) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
};

export const originTitle = (target: OriginApproval) =>
  `Let agents send to ${originHost(target.origin)}?`;

/** "wants to send to staging.ledger.dev", after the session's title (the inbox, hover cards). */
export const wantsToSend = (target: OriginApproval) =>
  `wants to send to ${originHost(target.origin)}`;

/** "Fix overdue totals wants to POST /invoices/overdue there. It isn't on this host, …" */
export const originBody = (who: string, target: OriginApproval) =>
  `${who} wants to ${target.method} ${target.path} there. It isn't on this host, so no agent can send to it until you approve it.`;

/** "Fix overdue totals · turn 12"; the session alone when the Turn isn't known here. */
export const byLine = (who: string, turn: number | null) =>
  turn === null ? who : `${who} · turn ${turn}`;

/** The well's rows: what Approve lets agents reach, exactly; never a secret's value. */
export const originRows = (
  target: OriginApproval,
  by: string
): ReadonlyArray<readonly [label: string, value: string]> => {
  const from =
    target.variable === undefined
      ? null
      : `{{${target.variable}}}${target.environment === undefined ? "" : ` · env ${target.environment}`}`;

  return [
    ["Origin", shownOrigin(target.origin)],
    ...(from === null ? [] : [["From", from] as const]),
    ["Send", `${target.method} ${target.path}${target.write ? " · a write" : ""}`],
    ["By", by],
    ...(target.tokenSource === undefined
      ? []
      : [["Token", `${target.tokenSource.file} · ${target.tokenSource.name}`] as const]),
  ];
};

/** What the waiting Send needs: a write is denied by Reads only, so it pre-selects writes. */
export const neededScope = (target: OriginApproval): OriginScope =>
  target.write ? "reads-and-writes" : "reads";

export const originScopes = (target: OriginApproval) =>
  [
    {
      scope: "reads-and-writes",
      label: "Reads and writes",
      note: target.write ? `this send is a ${target.method}` : null,
    },
    { scope: "reads", label: "Reads only", note: "GET, HEAD, OPTIONS" },
  ] as const;

/** "For this origin only. Reads only denies this send. Agents never see the token." */
export const originNote = (target: OriginApproval) =>
  [
    "For this origin only.",
    ...(target.write ? ["Reads only denies this send."] : []),
    ...(target.tokenSource === undefined ? [] : ["Agents never see the token."]),
  ].join(" ");

export const ORIGIN_SETTLED = {
  approved: "Approved. Agents can send to it now.",
  denied: "Denied. The agent's send didn't go.",
} as const;

/** The Origin Approval in a request; null for any other approval. */
export const originTarget = (request: ApprovalRequest): OriginApproval | null =>
  request.origin ?? null;

/** Approve remembers the origin with the chosen scope, on the Host. */
export const approveOrigin = (scope: OriginScope): ApprovalDecision =>
  Decisions.Allow({ remember: true, originScope: scope });
