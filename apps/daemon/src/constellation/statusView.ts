import {
  Constellation,
  ConstellationResult,
  type ConstellationEvent,
  type TaskId,
} from "@polaris/protocol";
import type { ConstellationRecord } from "../store/constellation.ts";
import { graphData } from "./data.ts";
import { childTasks } from "./parents.ts";
import { projectTask } from "./projections.ts";

/** What a status read covers (ENG-281): changes since a revision, one Task's subtree, open Tasks only. */
export interface StatusView {
  readonly since?: number;
  readonly task?: TaskId;
  readonly openOnly?: boolean;
}

export interface StatusScope {
  /** In the requested subtree: its events, questions, proposals and review state. */
  readonly inScope: (id: TaskId) => boolean;
  /** Listed in the tree: in scope, and open or a parent of an open Task when openOnly. */
  readonly shown: (id: TaskId) => boolean;
}

const subtree = (record: ConstellationRecord, id: TaskId): ReadonlyArray<TaskId> => [
  id,
  ...childTasks(record.graph.tasks, id).flatMap((child) => subtree(record, child.id)),
];

/** Null when the view filters nothing. */
export const statusScope = (record: ConstellationRecord, view: StatusView): StatusScope | null => {
  if (view.task === undefined && view.openOnly !== true) return null;

  const { tasks } = record.graph;

  const scope = new Set(
    view.task === undefined ? tasks.map((t) => t.id) : subtree(record, view.task)
  );

  const inScope = (id: TaskId) => scope.has(id);

  if (view.openOnly !== true) return { inScope, shown: inScope };

  const closed = new Set(
    tasks
      .filter((t) => t.canceled || ["done", "canceled"].includes(projectTask(record, t).state))
      .map((t) => t.id)
  );

  const open = (id: TaskId): boolean =>
    !closed.has(id) || childTasks(tasks, id).some((child) => open(child.id));

  return { inScope, shown: (id) => scope.has(id) && open(id) };
};

const attemptTask = (record: ConstellationRecord, attemptId: string) =>
  record.graph.attempts.find((a) => a.id === attemptId)?.taskId ?? null;

/** The Task an event is about, for `since` lines; null for Constellation-wide events. */
export const eventTask = (record: ConstellationRecord, e: ConstellationEvent): TaskId | null => {
  if ("taskId" in e) return e.taskId;

  if ("attempt" in e) return e.attempt.taskId;

  if ("attemptId" in e) return attemptTask(record, e.attemptId);

  if ("by" in e && "proposalId" in e) return attemptTask(record, e.by);

  if ("task" in e) return e.task.id;

  if ("from" in e && "to" in e && "text" in e) return attemptTask(record, e.from);

  return null;
};

/** The JSON a filtered status returns: shown Tasks with their Attempts, questions and projections. */
export const scopedResult = (
  record: ConstellationRecord,
  result: ConstellationResult,
  scope: StatusScope | null
): ConstellationResult => {
  const graph = result.constellation;

  if (scope === null || graph === null) return result;

  const inScope = (attemptId: string) => {
    const task = attemptTask(record, attemptId);

    return task !== null && scope.inScope(task);
  };

  return new ConstellationResult({
    summary: result.summary,
    next: result.next,
    revision: result.revision,
    sequence: result.sequence,
    constellation: new Constellation({
      ...graphData(graph),
      tasks: graph.tasks.filter((t) => scope.shown(t.id)),
      attempts: graph.attempts.filter((a) => scope.shown(a.taskId)),
      openQuestions: graph.openQuestions.filter((q) => inScope(q.attemptId)),
    }),
    projections: result.projections.filter((p) => scope.shown(p.taskId)),
    proposals: result.proposals.filter((p) => inScope(p.by)),
  });
};
