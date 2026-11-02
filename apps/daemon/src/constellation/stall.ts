import {
  STALL_AFTER_MS,
  StallAudit,
  type Attempt,
  type AttemptId,
  type TaskId,
} from "@polaris/protocol";
import { Predicate } from "effect";
import { phaseOf, slotOf, type SlotSource } from "./slots.ts";
import type { ConstellationRecord } from "../store/constellation.ts";
import type { SessionRecord } from "../store/model.ts";
import { pendingInputs } from "./delivery/messages.ts";
import { isParent } from "./parents.ts";
import { activeAttempt, latestAttempt, projectTask } from "./projections.ts";
import { heldWait, workerWait } from "./waiting.ts";

type Sessions = ReadonlyMap<Attempt["sessionId"], SessionRecord>;

const hasWorkingTurn = (sessions: Sessions, sessionId: Attempt["sessionId"]) =>
  sessions.get(sessionId)?.turns.some((t) => t.status === "working") === true;

/**
 * The brief ran, the last Turn ended cleanly, the nudge is spent, nothing is queued, and it
 * isn't Waiting on Background Work.
 */
const silentWorker = (record: ConstellationRecord, sessions: Sessions, a: Attempt, now: number) => {
  const session = sessions.get(a.sessionId);
  const last = session?.turns.at(-1);

  return (
    heldWait(record, a, session, now) === null &&
    a.state === "working" &&
    a.nudgedAt !== null &&
    a.sessionId !== record.graph.leadSessionId &&
    latestAttempt(record.graph, a.taskId)?.id === a.id &&
    !record.stale.has(a.id) &&
    last !== undefined &&
    last.startedAt >= a.startedAt &&
    last.status === "completed" &&
    !record.graph.pendingNotifications.some(
      (n) => Predicate.isTagged(n.item, "Stopped") && n.item.attemptId === a.id
    )
  );
};

const silentWorkers = (
  record: ConstellationRecord,
  sessions: Sessions,
  now: number
): ReadonlyArray<TaskId> => {
  const queued = new Set(pendingInputs(record).map((i) => i.sessionId));

  return record.graph.attempts
    .filter((a) => !queued.has(a.sessionId) && silentWorker(record, sessions, a, now))
    .map((a) => a.taskId);
};

/**
 * When the next held wait of a local working Attempt runs out, so the runner wakes to nudge
 * the worker or name it stalled; null while no wait holds.
 */
export const nextWaitExpiry = (
  record: ConstellationRecord,
  sessions: Sessions,
  host: SlotSource
): number | null => {
  const due = record.graph.attempts.flatMap((a) => {
    const session = sessions.get(a.sessionId);

    if (a.hostId !== host.hostId || session === undefined) return [];
    const wait = workerWait(record, a, session);

    return wait !== null && wait.until > host.now ? [wait.until] : [];
  });

  return due.length === 0 ? null : Math.min(...due);
};

/** A promoted Gate nobody is carrying: ready work with no owner. */
export const stalledGates = (record: ConstellationRecord): ReadonlyArray<TaskId> =>
  record.graph.tasks
    .filter((task) => {
      const attempt = latestAttempt(record.graph, task.id);

      return (
        task.kind === "gate" &&
        !task.canceled &&
        record.promoted.has(task.id) &&
        (attempt === undefined || !activeAttempt(attempt)) &&
        attempt?.state !== "accepted"
      );
    })
    .map((task) => task.id);

/** The Lead heard everything, its Turn ended, and the whole Constellation still waits on it. */
const silentLead = (record: ConstellationRecord, sessions: Sessions, gates: number) => {
  const { graph } = record;
  const lead = sessions.get(graph.leadSessionId);

  if (
    lead === undefined ||
    lead.turns.length === 0 ||
    hasWorkingTurn(sessions, graph.leadSessionId) ||
    graph.pendingNotifications.length > 0 ||
    pendingInputs(record).some((i) => i.sessionId === graph.leadSessionId)
  )
    return false;

  if (graph.attempts.some((a) => activeAttempt(a) && a.state !== "review")) return false;

  const ready = graph.tasks.some(
    (task) => !isParent(graph, task.id) && projectTask(record, task).state === "ready"
  );

  return gates > 0 || ready || graph.attempts.some((a) => a.state === "review");
};

/** This Host's working Attempts, each with its worker phase from the folds. */
const localPhases = (record: ConstellationRecord, sessions: Sessions, host: SlotSource) =>
  record.graph.attempts.flatMap((a) => {
    const session = sessions.get(a.sessionId);

    return a.state !== "working" ||
      a.hostId !== host.hostId ||
      session === undefined ||
      record.stale.has(a.id) ||
      latestAttempt(record.graph, a.taskId)?.id !== a.id
      ? []
      : [{ attempt: a, phase: phaseOf(record, a, session, host) }];
  });

/** Slot holders with no first Turn past the grace period that no audit has named yet. */
const newSlotStalls = (
  record: ConstellationRecord,
  sessions: Sessions,
  host: SlotSource | undefined
): ReadonlyArray<AttemptId> =>
  host === undefined
    ? []
    : localPhases(record, sessions, host)
        .filter((w) => w.phase.kind === "stalled" && !record.slotStalls.has(w.attempt.id))
        .map((w) => w.attempt.id);

/**
 * When the next slot holder still starting becomes stalled, so the Lead hears it without a
 * Turn end to wake it; null while no local worker holds a slot with no first Turn.
 */
export const nextSlotStall = (
  record: ConstellationRecord,
  sessions: Sessions,
  host: SlotSource
): number | null => {
  const due = localPhases(record, sessions, host).flatMap(({ attempt, phase }) =>
    phase.kind === "starting" &&
    !phase.afterTurn &&
    !record.slotStalls.has(attempt.id) &&
    slotOf(attempt, host)?.kind === "held"
      ? [Date.parse(phase.since) + STALL_AFTER_MS]
      : []
  );

  return due.length === 0 ? null : Math.min(...due);
};

/**
 * Demand-driven: computed from the fold and the Session records at a trigger point, never
 * on a timer of its own. Returns null when nothing has stalled.
 */
export const stallAudit = (
  record: ConstellationRecord,
  sessions: Sessions,
  host?: SlotSource
): StallAudit | null => {
  if (record.graph.state !== "running") return null;
  const working = silentWorkers(record, sessions, host?.now ?? Date.now());
  const gates = stalledGates(record);
  const lead = silentLead(record, sessions, gates.length);
  const slots = newSlotStalls(record, sessions, host);

  if (working.length === 0 && gates.length === 0 && !lead && slots.length === 0) return null;

  return new StallAudit({
    key: JSON.stringify([
      [...working].sort(),
      [...gates].sort(),
      lead,
      record.graph.attempts.filter((a) => a.state === "review").map((a) => a.id),
    ]),
    working,
    gates,
    lead,
    slots,
  });
};

/** Due when its stalled state changed (`key`) or it names a slot stall no audit has named. */
export const auditIsNew = (record: ConstellationRecord, audit: StallAudit): boolean =>
  audit.key !== record.lastAudit ||
  (audit.slots ?? []).some((attemptId) => !record.slotStalls.has(attemptId));

/** The same stalled state is noted to the Lead once; a changed state is a new audit. */
export const dueAudit = (
  record: ConstellationRecord,
  sessions: Sessions,
  host?: SlotSource
): StallAudit | null => {
  const audit = stallAudit(record, sessions, host);

  return audit === null || !auditIsNew(record, audit) ? null : audit;
};

export const auditLines = (
  audit: StallAudit,
  record?: ConstellationRecord
): ReadonlyArray<string> => {
  const lines: Array<string> = [];

  const slots = (audit.slots ?? []).map(
    (id) => record?.graph.attempts.find((a) => a.id === id)?.taskId ?? id
  );

  if (slots.length === 1)
    lines.push(
      `Stalled: ${slots[0]} holds a worker slot with no Turn yet. The user can press Start on it in the Desktop App, or stop the Attempt to free the slot.`
    );

  if (slots.length > 1)
    lines.push(
      `Stalled: ${slots.join(", ")} hold worker slots with no Turn yet. The user can press Start on each in the Desktop App, or stop the Attempts to free the slots.`
    );

  if (audit.working.length > 0)
    lines.push(
      `Stalled: ${audit.working.join(", ")} ${audit.working.length === 1 ? "is" : "are"} working with no active Turn and no queued input. Message the worker with a concrete next action, or stop the Attempt.`
    );

  if (audit.gates.length > 0)
    lines.push(
      `Ready and unclaimed: Gate ${audit.gates.join(", ")} ${audit.gates.length === 1 ? "has" : "have"} every dependency accepted and no Attempt. Dispatch it to your own session and run its checks.`
    );

  if (audit.lead)
    lines.push(
      "Nothing is in flight. Review the pending Claims, dispatch the ready Tasks, or say what blocks you."
    );

  return lines;
};
