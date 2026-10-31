/**
 * A Data Source's pending approval as Data's connection card shows it: the same card the
 * conversation shows, answered through RespondToApproval, so either place settles both.
 */
import type { ApprovalRequest, DataSource, SessionId } from "@polaris/protocol";
import { useMemo } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { DataSourceApprovalCard } from "./DataSourceApprovalCard.tsx";
import { sameTarget } from "./decide.ts";
import { askedBy, type DataSourceTarget, dataSourceTarget } from "./model.ts";

export interface PendingDataApprovalEntry {
  readonly request: ApprovalRequest;
  readonly target: DataSourceTarget;
  readonly sessionId: SessionId;
  readonly sessionTitle: string;
}

/**
 * The oldest open approval for this Data Source's target across the Host's Agent Sessions,
 * matched by server, database and user as the Daemon keys it, so a rename keeps it (F12).
 */
export const usePendingDataApproval = (
  hostKey: string,
  source: DataSource
): PendingDataApprovalEntry | null => {
  const sessions = useApp((s) => s.hostModels[hostKey]?.sessions);

  return useMemo(() => {
    let oldest: PendingDataApprovalEntry | null = null;

    for (const { session, pendingApprovals } of sessions?.values() ?? []) {
      for (const request of pendingApprovals) {
        const target = dataSourceTarget(request);

        if (target === null || !sameTarget(target, source)) continue;

        if (oldest !== null && oldest.request.openedAt <= request.openedAt) continue;
        oldest = { request, target, sessionId: session.id, sessionTitle: session.title };
      }
    }

    return oldest;
  }, [sessions, source]);
};

/** For the connection card: the source's pending approval, or nothing. */
export const PendingDataApproval = ({
  hostKey,
  source,
}: {
  readonly hostKey: string;
  readonly source: DataSource;
}) => {
  const pending = usePendingDataApproval(hostKey, source);
  const hostLabel = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.label ?? "this Host");

  if (pending === null) return null;
  const { request, target, sessionTitle } = pending;

  return (
    <DataSourceApprovalCard
      key={request.id}
      hostKey={hostKey}
      request={request}
      target={target}
      who={askedBy(sessionTitle)}
      hostLabel={hostLabel}
      alreadyApproved={source.access === "approved"}
    />
  );
};
