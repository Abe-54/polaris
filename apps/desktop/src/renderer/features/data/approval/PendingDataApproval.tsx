/**
 * A Data Source's pending approval as Data's connection card shows it: the same card the
 * conversation shows, answered through RespondToApproval, so either place settles both.
 */
import type { ApprovalRequest, SessionId } from "@polaris/protocol";
import { useMemo } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { respond } from "../../needs-you/respond.ts";
import { DataSourceApprovalCard } from "./DataSourceApprovalCard.tsx";
import { type DataSourceTarget, dataSourceTarget } from "./model.ts";

export interface PendingDataApprovalEntry {
  readonly request: ApprovalRequest;
  readonly target: DataSourceTarget;
  readonly sessionId: SessionId;
  readonly sessionTitle: string;
}

/** The oldest open approval for this Data Source across the Host's Agent Sessions. */
export const usePendingDataApproval = (
  hostKey: string,
  sourceId: string
): PendingDataApprovalEntry | null => {
  const sessions = useApp((s) => s.hostModels[hostKey]?.sessions);

  return useMemo(() => {
    let oldest: PendingDataApprovalEntry | null = null;

    for (const { session, pendingApprovals } of sessions?.values() ?? []) {
      for (const request of pendingApprovals) {
        const target = dataSourceTarget(request);

        if (target?.sourceId !== sourceId) continue;

        if (oldest !== null && oldest.request.openedAt <= request.openedAt) continue;
        oldest = { request, target, sessionId: session.id, sessionTitle: session.title };
      }
    }

    return oldest;
  }, [sessions, sourceId]);
};

/** For the connection card: the source's pending approval, or nothing. */
export const PendingDataApproval = ({
  hostKey,
  sourceId,
}: {
  readonly hostKey: string;
  readonly sourceId: string;
}) => {
  const pending = usePendingDataApproval(hostKey, sourceId);
  const hostLabel = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.label ?? "this Host");

  if (pending === null) return null;
  const { request, target, sessionId, sessionTitle } = pending;

  return (
    <DataSourceApprovalCard
      key={request.id}
      target={target}
      who={sessionTitle === "" ? "An agent session" : sessionTitle}
      hostLabel={hostLabel}
      onDecide={(decision) => void respond({ hostKey, sessionId, requestId: request.id, decision })}
    />
  );
};
