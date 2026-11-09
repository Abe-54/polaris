import type { Attempt, Constellation, TaskDefinition, TaskPatch } from "@polaris/protocol";

export const taskData = (task: TaskDefinition) => ({
  id: task.id,
  title: task.title,
  kind: task.kind,
  deps: task.deps,
  area: task.area,
  brief: task.brief,
  criteria: task.criteria,
  suggested: task.suggested,
  group: task.group,
  parent: task.parent,
});

/** An Edit's patch over the current Task: omitted keeps, null or [] clears (ENG-412). */
export const patchedTaskData = (task: TaskDefinition, patch: TaskPatch) => {
  const current = taskData(task);

  return {
    ...current,
    title: patch.title ?? current.title,
    kind: patch.kind ?? current.kind,
    deps: patch.deps === undefined ? current.deps : (patch.deps ?? []),
    area: patch.area === undefined ? current.area : (patch.area ?? []),
    brief: patch.brief === undefined ? current.brief : (patch.brief ?? ""),
    criteria: patch.criteria === undefined ? current.criteria : (patch.criteria ?? []),
    suggested: patch.suggested === undefined ? current.suggested : patch.suggested,
    group: patch.group === undefined ? current.group : patch.group,
    parent: patch.parent === undefined ? current.parent : patch.parent,
  };
};

export const attemptData = (attempt: Attempt) => ({
  id: attempt.id,
  taskId: attempt.taskId,
  revision: attempt.revision,
  cause: attempt.cause,
  by: attempt.by,
  sessionId: attempt.sessionId,
  hostId: attempt.hostId,
  worktree: attempt.worktree,
  branch: attempt.branch,
  base: attempt.base,
  startupSetup: attempt.startupSetup,
  state: attempt.state,
  claim: attempt.claim,
  mergedHead: attempt.mergedHead,
  receipts: attempt.receipts,
  evidence: attempt.evidence,
  claimedAt: attempt.claimedAt,
  claimRevision: attempt.claimRevision,
  previousClaimHead: attempt.previousClaimHead,
  approvedByUserAt: attempt.approvedByUserAt,
  handedUpAt: attempt.handedUpAt,
  handedUpReason: attempt.handedUpReason,
  rejectionReason: attempt.rejectionReason,
  rejectedBy: attempt.rejectedBy,
  nudgedAt: attempt.nudgedAt,
  settleReason: attempt.settleReason,
  failureKind: attempt.failureKind,
  resetsAt: attempt.resetsAt,
  blockedOn: attempt.blockedOn,
  blockedReason: attempt.blockedReason,
  blockedAt: attempt.blockedAt,
  startedAt: attempt.startedAt,
  endedAt: attempt.endedAt,
});

export const graphData = (graph: Constellation) => ({
  id: graph.id,
  workspaceId: graph.workspaceId,
  hostId: graph.hostId,
  leadSessionId: graph.leadSessionId,
  name: graph.name,
  state: graph.state,
  revision: graph.revision,
  settings: graph.settings,
  tasks: graph.tasks,
  attempts: graph.attempts,
  pendingNotifications: graph.pendingNotifications,
  openQuestions: graph.openQuestions,
  createdAt: graph.createdAt,
  updatedAt: graph.updatedAt,
});
