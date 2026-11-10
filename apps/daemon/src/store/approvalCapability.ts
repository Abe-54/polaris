import type { ApprovalKind, Capability } from "@polaris/protocol";

/** The capability a Client needs to decode an approval of `kind`, or null for the kinds all decode. */
export const approvalCapability = (kind: ApprovalKind): Capability | null => {
  if (kind === "secret") return "approval.secret";

  return kind === "app" || kind === "headed-input" ? "computer-use" : null;
};
