/** Which answers an Extension may give an approval (packages/protocol/computer-use.md). */
import {
  Actor,
  appDecisionRefusal,
  ApprovalDecision,
  type ApprovalRequest,
  PairingId,
} from "@polaris/protocol";

const EXTENSION = Actor.cases.Extension.make({ pairingId: PairingId.make("sdk"), name: "sdk" });

const REMEMBER = ApprovalDecision.cases.Allow.make({ remember: true });

/**
 * Whether an Extension may answer with `{ kind: "allow", remember: true }`. Never for a
 * question or a secret, and never for computer use: the Daemon refuses an Extension's "always".
 */
export const alwaysAllowable = (request: Pick<ApprovalRequest, "kind">): boolean =>
  request.kind !== "question" &&
  request.kind !== "secret" &&
  appDecisionRefusal(request.kind, REMEMBER, EXTENSION) === null;
