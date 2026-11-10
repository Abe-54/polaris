/**
 * A `computer-use` request in the transcript: the session asked for computer use while it's off,
 * so U1's inline prompt (Paper CU3) shows. Turning it on clears it; Not now denies it.
 */
import type { ApprovalDecision, ApprovalRequest } from "@polaris/protocol";
import { type Harness, harnessHue } from "@polaris/ui";
import { Decisions } from "../../../commands.ts";
import { useApp } from "../../../shell/hooks.ts";
import { ComputerUsePrompt, hostFactsOf } from "../../computer-use/index.ts";

export interface ComputerUseRequestCardProps {
  readonly request: ApprovalRequest;
  readonly hostKey: string;
  readonly harness: Harness | null;
  readonly onRespond: (request: ApprovalRequest, decision: ApprovalDecision) => void;
}

export const ComputerUseRequestCard = ({
  request,
  hostKey,
  harness,
  onRespond,
}: ComputerUseRequestCardProps) => {
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey));
  const notice = request.computerUse;

  if (host === undefined || notice === undefined)
    return <p className="text-caption text-needs-you">{request.title}</p>;

  return (
    <ComputerUsePrompt
      hostKey={host.key}
      host={hostFactsOf(host)}
      ask={{ harness: harness === null ? "The agent" : harnessHue(harness).name, app: notice.app }}
      onNotNow={() => onRespond(request, Decisions.Deny({ reason: null }))}
    />
  );
};
