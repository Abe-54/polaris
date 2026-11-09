/**
 * The Origin Approval card (DESIGN.md, Requests → States; Paper Q3): Data's approval anatomy for an
 * agent's Send to a Remote Origin. The conversation and Requests show the same card; answering in
 * either goes through RespondToApproval and settles both.
 */
import type { ApprovalDecision, ApprovalRequest, OriginApproval } from "@polaris/protocol";
import { useShownApproval } from "../../../shell/approvalInView.ts";
import { decide as send } from "../../needs-you/respond.ts";
import {
  ApprovalFrame,
  ApprovalNote,
  ApprovalScope,
  ApprovalWell,
} from "../../data/approval/ApprovalAnatomy.tsx";
import {
  setOriginApprovalScope,
  useDecidedHere,
  useOriginApprovalScope,
} from "../../data/approval/decide.ts";
import { denyDecision, rememberedOn } from "../../data/approval/model.ts";
import {
  approveOrigin,
  byLine,
  neededScope,
  ORIGIN_SETTLED,
  originBody,
  originNote,
  originRows,
  originScopes,
  originTitle,
} from "./model.ts";

export interface OriginApprovalCardProps {
  readonly hostKey: string;
  readonly request: ApprovalRequest;
  readonly target: OriginApproval;
  /** The asking Agent Session's title, in every view. */
  readonly who: string;
  /** The asking Turn's number, when the view knows it. */
  readonly turn: number | null;
  readonly hostLabel: string;
}

export const OriginApprovalCard = ({
  hostKey,
  request,
  target,
  who,
  turn,
  hostLabel,
}: OriginApprovalCardProps) => {
  const scope = useOriginApprovalScope(request.id, neededScope(target));
  const decided = useDecidedHere(request.id);
  const shownRef = useShownApproval(request.id);

  const decide = (decision: ApprovalDecision) =>
    void send({ hostKey, sessionId: request.sessionId, request }, decision);

  return (
    <ApprovalFrame
      shownRef={shownRef}
      testId="origin-approval"
      title={originTitle(target)}
      body={originBody(who, target)}
      remembered={rememberedOn(hostLabel)}
      settled={decided === null ? null : ORIGIN_SETTLED[decided]}
      onDeny={() => decide(denyDecision())}
      onApprove={() => decide(approveOrigin(scope))}
    >
      <ApprovalWell rows={originRows(target, byLine(who, turn))} testId="origin-approval-target" />
      <ApprovalScope
        options={originScopes(target)}
        value={scope}
        disabled={decided !== null}
        onChange={(s) => setOriginApprovalScope(request.id, s)}
      />
      <ApprovalNote>{originNote(target)}</ApprovalNote>
    </ApprovalFrame>
  );
};
