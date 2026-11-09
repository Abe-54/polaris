/** Origin Approvals: the gate on agents' Sends to Remote Origins (ADR 0098). */
export {
  OriginApprovals,
  OriginApprovalRequired,
  type AgentSend,
  type AgentSendContext,
} from "./service.ts";

export { OriginApprovalsLive, originApprovalsLayer } from "./layer.ts";

export {
  TUNNEL_EXECUTABLES,
  originLocality,
  ownersLocality,
  parseOrigin,
  type OwnerLookup,
} from "./locality.ts";

export { READS_ONLY, scopeAllows, type OriginOutcome, type OriginRule } from "./store.ts";
