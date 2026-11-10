import { DomainEvent, type BackgroundTask } from "@polaris/protocol";
import { endBackgroundWork } from "./session.subagents.ts";
import type { Emitted, SessionInput } from "./session.inputs.ts";
import { type SessionRecord, workingTurn } from "../store/model.ts";

export const waitingOnBackgroundWork = (record: SessionRecord): boolean =>
  record.subagents.size > 0 || record.session.backgroundTasks.length > 0;

/** Why `StopBackgroundTasks` is refused, or null: it needs live tasks, each one named known. */
export const backgroundStopRefusal = (
  record: SessionRecord,
  input: Extract<SessionInput, { type: "background.stop" }>
): string | null => {
  const live = new Set(record.session.backgroundTasks.map((task) => task.id));

  if (!input.canStop) return `${record.session.harness} cannot stop background work`;

  if (live.size === 0) return "there is no background work to stop";
  const unknown = input.taskIds?.find((id) => !live.has(id));

  return unknown === undefined ? null : `there is no background task ${unknown}`;
};

/** Why `BackgroundCommand` is refused, or null: the Turn in flight must be running that command. */
export const commandBackgroundRefusal = (
  record: SessionRecord,
  input: Extract<SessionInput, { type: "command.background" }>
): string | null => {
  if (!input.canBackground)
    return `${record.session.harness} cannot run a command in the background`;

  if (workingTurn(record) === undefined || record.session.state === "in-terminal")
    return "there is no Turn in flight";

  if (input.itemId === null) return input.running.length === 0 ? "no command is running" : null;

  return input.running.includes(input.itemId) ? null : `command ${input.itemId} is not running`;
};

export const backgroundTasksChanged = (
  record: SessionRecord,
  { tasks, reportsPending }: { tasks: ReadonlyArray<BackgroundTask>; reportsPending: boolean }
) => [
  DomainEvent.cases.SessionBackgroundTasksChanged.make({
    sessionId: record.session.id,
    tasks,
    reportsPending,
  }),
];

export const idleStopEffect = (record: SessionRecord): Emitted[] =>
  record.session.state === "idle" ? [{ type: "effect", effect: "scheduleIdleStop" }] : [];

export const backgroundIdleStop = (
  record: SessionRecord,
  event: Extract<SessionInput, { type: "idle.timeout" }>
) =>
  !event.harnessLive || (waitingOnBackgroundWork(record) && event.backgroundExpired !== true)
    ? null
    : {
        events:
          event.backgroundExpired === true
            ? endBackgroundWork(record, event.at ?? record.session.updatedAt)
            : [],
        reason: event.backgroundExpired === true ? "background-idle-timeout" : "idle-timeout",
      };
