/**
 * The Data Source Approval card (DESIGN.md, Data; Paper "Let agents read analytics?"): the exact
 * target in a well, the scope, Deny and Approve, and the Host that remembers it. A Needs You.
 * Every view of one request shares its scope and shows a decision made in any of them.
 */
import type { ApprovalDecision, ApprovalRequest } from "@polaris/protocol";
import { useEffect } from "react";
import { useShownApproval } from "../../../shell/approvalInView.ts";
import { decide as send } from "../../needs-you/respond.ts";
import { ApprovalFrame, ApprovalNote, ApprovalScope, ApprovalWell } from "./ApprovalAnatomy.tsx";
import { setApprovalScope, settleOnce, useApprovalScope, useDecidedHere } from "./decide.ts";
import {
  approvalBody,
  approvalTitle,
  approveDecision,
  DATA_APPROVAL_FOOTNOTE,
  type DataSourceTarget,
  denyDecision,
  rememberedOn,
  SCOPES,
  scopeNote,
  targetRows,
} from "./model.ts";

export interface DataSourceApprovalCardProps {
  readonly hostKey: string;
  readonly request: ApprovalRequest;
  readonly target: DataSourceTarget;
  /** The asking Agent Session's title, "Backfill currency", in every view. */
  readonly who: string;
  readonly hostLabel: string;
  /** The target is approved already (another session's request, another device): it settles. */
  readonly alreadyApproved: boolean;
}

const SETTLED = {
  approved: "Approved. Agents can read it now.",
  denied: "Denied. No agent can reach it.",
} as const;

export const DataSourceApprovalCard = ({
  hostKey,
  request,
  target,
  who,
  hostLabel,
  alreadyApproved,
}: DataSourceApprovalCardProps) => {
  const scope = useApprovalScope(request.id);
  const decided = useDecidedHere(request.id);
  const shownRef = useShownApproval(request.id);

  const decide = (decision: ApprovalDecision) =>
    void send({ hostKey, sessionId: request.sessionId, request }, decision);

  // Approved already, the request only holds the agent up: answering it lets it go on.
  useEffect(() => {
    if (alreadyApproved && decided === null && settleOnce(request.id))
      void send({ hostKey, sessionId: request.sessionId, request }, approveDecision("target"));
  }, [alreadyApproved, decided, hostKey, request]);

  return (
    <ApprovalFrame
      shownRef={shownRef}
      testId="data-approval"
      title={approvalTitle(target)}
      body={approvalBody(who, target)}
      remembered={rememberedOn(hostLabel)}
      settled={decided === null ? null : SETTLED[decided]}
      onDeny={() => decide(denyDecision())}
      onApprove={() => decide(approveDecision(scope))}
    >
      <ApprovalWell rows={targetRows(target)} testId="data-approval-target" />
      <ApprovalScope
        options={SCOPES.map(({ scope: s, label }) => ({
          scope: s,
          label,
          note: scopeNote(target, s),
        }))}
        value={scope}
        disabled={decided !== null}
        onChange={(s) => setApprovalScope(request.id, s)}
      />
      <ApprovalNote>{DATA_APPROVAL_FOOTNOTE}</ApprovalNote>
    </ApprovalFrame>
  );
};
