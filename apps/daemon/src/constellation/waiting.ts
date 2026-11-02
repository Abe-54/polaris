/**
 * Waiting on Background Work (ENG-742): a working Attempt whose worker ended its Turn with
 * background work out. It is neither stopped nor stalled, so it is not nudged and the Lead
 * hears nothing until the wait runs out. Derived from folded events only.
 */
import { type Attempt, type HarnessKind, WorkerWaiting } from "@polaris/protocol";
import type { ConstellationRecord } from "../store/constellation.ts";
import type { SessionRecord } from "../store/model.ts";

/**
 * After background work ends, the Harness's own Turn should start at once (Claude Code took
 * 0.1 s in the ENG-742 recordings); two minutes covers a loaded Host before the worker is nudged.
 */
export const WAIT_GRACE_MS = 2 * 60_000;

/**
 * The longest a wait holds off a nudge: past the 9-minute script and long pre-push hooks
 * of ENG-742 and most full test runs, and a 60-minute cap on what `wait` may declare.
 */
export const WAIT_CEILING_MS = 60 * 60_000;

/** Harnesses that start a Turn themselves when background work reports (`harness/claude/README.md`). */
const WAKES_ON_BACKGROUND: ReadonlySet<HarnessKind> = new Set(["claude"]);

export const wakesOnBackground = (harness: HarnessKind) => WAKES_ON_BACKGROUND.has(harness);

interface Ended {
  readonly startedAt: string;
  readonly endedAt: string;
}

/** The Session's latest Turn, when it is this Attempt's and ended cleanly. */
const endedTurn = (attempt: Attempt, session: SessionRecord): Ended | null => {
  const last = session.turns.at(-1);

  return last === undefined ||
    last.status !== "completed" ||
    last.endedAt === null ||
    last.startedAt < attempt.startedAt
    ? null
    : { startedAt: last.startedAt, endedAt: last.endedAt };
};

/** What the Harness reported still running, background subagents included. */
const liveTasks = (session: SessionRecord): WorkerWaiting["tasks"] => {
  const tasks = session.session.backgroundTasks;
  const known = new Set(tasks.map((t) => t.id));

  const subagents = [...session.subagents.values()].flatMap((s) =>
    known.has(s.id) ? [] : [{ id: s.id, kind: "subagent" as const, description: s.title }]
  );

  return [
    ...tasks.map((t) => ({ id: t.id, kind: t.kind, description: t.description })),
    ...subagents,
  ];
};

/** Background work the Harness will wake the worker for, or that ended after its Turn did. */
const harnessWait = (session: SessionRecord, turn: Ended) => {
  if (!wakesOnBackground(session.session.harness)) return null;
  const tasks = liveTasks(session);
  const ended = Date.parse(turn.endedAt);

  if (tasks.length > 0) return { tasks, since: turn.endedAt, until: ended + WAIT_CEILING_MS };
  const changed = session.session.backgroundChangedAt;

  // It ran past the Turn's end and just finished: the Harness's own Turn is due.
  return changed != null && Date.parse(changed) > ended
    ? { tasks, since: turn.endedAt, until: Date.parse(changed) + WAIT_GRACE_MS }
    : null;
};

/** A wait the worker declared during the Turn that just ended; its next Turn clears it. */
const declaredWait = (record: ConstellationRecord, attempt: Attempt, turn: Ended) => {
  const wait = record.waits.get(attempt.id);

  if (wait === undefined || wait.at < turn.startedAt) return null;
  const at = Date.parse(wait.at);

  return {
    on: wait.on,
    since: wait.at,
    until: Math.min(Date.parse(wait.until), at + WAIT_CEILING_MS) + WAIT_GRACE_MS,
  };
};

/**
 * The worker's wait, whether or not it still holds (`holds`): null while a Turn runs, once
 * the Attempt leaves working (a Claim, a block), or when nothing was left running.
 */
export const workerWait = (
  record: ConstellationRecord,
  attempt: Attempt,
  session: SessionRecord
): WorkerWaiting | null => {
  const turn = attempt.state === "working" ? endedTurn(attempt, session) : null;

  if (turn === null) return null;
  const harness = harnessWait(session, turn);
  const declared = declaredWait(record, attempt, turn);

  if (harness === null && declared === null) return null;

  return new WorkerWaiting({
    tasks: harness?.tasks ?? [],
    on: declared?.on ?? null,
    since: harness?.since ?? declared?.since ?? turn.endedAt,
    until: Math.max(harness?.until ?? 0, declared?.until ?? 0),
  });
};

/** The wait still covers a silent worker: no nudge, no Stopped, no stall. */
export const holds = (wait: WorkerWaiting | null, now: number): wait is WorkerWaiting =>
  wait !== null && now < wait.until;

/** The worker's wait when it holds at `now`, else null. */
export const heldWait = (
  record: ConstellationRecord,
  attempt: Attempt,
  session: SessionRecord | undefined,
  now: number
): WorkerWaiting | null => {
  const wait = session === undefined ? null : workerWait(record, attempt, session);

  return holds(wait, now) ? wait : null;
};
