import type { Attempt, ConstellationCommand, WorkerPlacement } from "@polaris/protocol";
import { Predicate } from "effect";
import { ignoredServiceTier } from "../harness/constellation/index.ts";
import type { ConstellationRecord } from "../store/constellation.ts";
import type { ReadModel } from "../store/model.ts";
import { BUILT_IN, taskDefaults } from "./composition/prepare.ts";

const placementFor = (command: ConstellationCommand, attempt: Attempt): WorkerPlacement | null => {
  if (Predicate.isTagged(command, "Dispatch"))
    return command.tasks.find((t) => t.taskId === attempt.taskId)?.worker ?? command.defaultWorker;

  if (Predicate.isTagged(command, "Review") && Predicate.isTagged(command.action, "SendBack"))
    return command.action.worker;

  return null;
};

/**
 * One line per new worker whose Harness has no service tier although one was asked for
 * (ENG-475): the worker runs normally on its default tier, and the Lead is told.
 */
export const ignoredTierNotes = (
  command: ConstellationCommand,
  record: ConstellationRecord,
  attempts: ReadonlyArray<Attempt>,
  sessions: ReadModel["sessions"]
): ReadonlyArray<string> => {
  const lead = sessions.get(record.graph.leadSessionId)?.session;

  return attempts.flatMap((attempt) => {
    const task = record.graph.tasks.find((t) => t.id === attempt.taskId);
    const placement = placementFor(command, attempt);

    if (task === undefined || task.kind === "gate" || Predicate.isTagged(placement, "Existing"))
      return [];
    const user = sessions.get(attempt.sessionId)?.session ?? lead ?? BUILT_IN;

    const ignored = ignoredServiceTier(
      placement?.selection ?? null,
      task.suggested,
      taskDefaults(record.graph, task),
      user
    );

    return ignored === null
      ? []
      : [
          `${task.id} runs on ${ignored.harness}, which has no service tier: ${ignored.serviceTier} was ignored.`,
        ];
  });
};
