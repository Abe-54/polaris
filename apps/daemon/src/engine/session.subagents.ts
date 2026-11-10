/**
 * The session machine's Subagent rules (README.md here): what each Harness
 * report or departure records. A Subagent is recorded only for the Turn in
 * flight, may outlive that Turn, and ends when the Harness says so, or
 * `interrupted` when the Harness goes away first.
 */
import { DomainEvent, Subagent, type SubagentStatus } from "@polaris/protocol";
import type { SessionRecord } from "../store/model.ts";
import type { SessionInput } from "./session.inputs.ts";

const endedAs = (
  subagent: Subagent,
  status: SubagentStatus,
  at: string,
  report: string | null = subagent.report ?? null
) =>
  DomainEvent.cases.SubagentEnded.make({
    subagent: new Subagent({
      id: subagent.id,
      sessionId: subagent.sessionId,
      turnId: subagent.turnId,
      parentItemId: subagent.parentItemId,
      title: subagent.title,
      agent: subagent.agent,
      model: subagent.model,
      background: subagent.background,
      report,
      status,
      startedAt: subagent.startedAt,
      endedAt: at,
    }),
  });

/** A Subagent the Harness spawned: recorded for the Turn in flight only, and once. */
export const subagentStarted = (
  record: SessionRecord,
  subagent: Subagent
): ReadonlyArray<DomainEvent> =>
  record.turns.find((t) => t.status === "working")?.id === subagent.turnId &&
  !record.subagents.has(subagent.id)
    ? [DomainEvent.cases.SubagentStarted.make({ subagent })]
    : [];

type SubagentEndedInput = Extract<SessionInput, { type: "harness.subagentEnded" }>;

/** The Harness reports a Subagent done; one that isn't open (a repeat, a stale report) changes nothing. */
export const subagentEnded = (
  record: SessionRecord,
  event: SubagentEndedInput
): ReadonlyArray<DomainEvent> => {
  const open = record.subagents.get(event.subagentId);

  return open === undefined ? [] : [endedAs(open, event.status, event.at, event.report ?? null)];
};

/** The Harness went away (exit, restart, failure, Archive): what it left open ends `interrupted`. */
export const endBackgroundWork = (record: SessionRecord, at: string): Array<DomainEvent> => [
  ...(record.session.backgroundTasks.length > 0 || record.session.backgroundReportsPending
    ? [
        DomainEvent.cases.SessionBackgroundTasksChanged.make({
          sessionId: record.session.id,
          tasks: [],
        }),
      ]
    : []),
  ...[...record.subagents.values()].map((subagent) => endedAs(subagent, "interrupted", at)),
];
