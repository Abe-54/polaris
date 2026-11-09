/**
 * Agents' Sends from this checkout waiting on an Origin Approval, as Requests shows them above the
 * request: the same card as the conversation, oldest first, from every Agent Session working here.
 */
import type { ApprovalRequest, OriginApproval } from "@polaris/protocol";
import { useMemo } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { askedBy } from "../../data/approval/model.ts";
import type { HostModel } from "../../../store/hostModel.ts";
import type { RequestsSessionKey } from "../model/session.ts";
import { OriginApprovalCard } from "./OriginApprovalCard.tsx";

export interface PendingOrigin {
  readonly request: ApprovalRequest;
  readonly target: OriginApproval;
  readonly sessionTitle: string;
}

/** Open Origin Approvals from sessions in the same checkout as `sessionId`, oldest first. */
export const pendingOrigins = (
  model: HostModel | undefined,
  sessionId: string
): ReadonlyArray<PendingOrigin> => {
  const cwd = model?.sessions.get(sessionId)?.session.cwd;

  if (model === undefined || cwd === undefined) return [];

  return [...model.sessions.values()]
    .filter(({ session }) => session.cwd === cwd)
    .flatMap(({ session, pendingApprovals }) =>
      pendingApprovals.flatMap((request) =>
        request.origin === undefined
          ? []
          : [{ request, target: request.origin, sessionTitle: session.title }]
      )
    )
    .toSorted((a, b) => a.request.openedAt.localeCompare(b.request.openedAt));
};

export const usePendingOrigins = (at: RequestsSessionKey) => {
  const model = useApp((s) => s.hostModels[at.hostKey]);

  return useMemo(() => pendingOrigins(model, at.sessionId), [model, at.sessionId]);
};

export const PendingOriginApprovals = ({ at }: { readonly at: RequestsSessionKey }) => {
  const pending = usePendingOrigins(at);
  const hostLabel = useApp((s) => s.hosts.find((h) => h.key === at.hostKey)?.label ?? "this Host");

  if (pending.length === 0) return null;

  return (
    <div
      className="border-hairline px-panel flex max-h-[60%] shrink-0 flex-wrap gap-3 overflow-y-auto border-b py-3"
      data-testid="requests-origin-approvals"
    >
      {pending.map(({ request, target, sessionTitle }) => (
        <OriginApprovalCard
          key={request.id}
          hostKey={at.hostKey}
          request={request}
          target={target}
          who={askedBy(sessionTitle)}
          turn={null}
          hostLabel={hostLabel}
        />
      ))}
    </div>
  );
};
