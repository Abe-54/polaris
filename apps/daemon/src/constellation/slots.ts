import {
  type Attempt,
  type AttemptId,
  type ConstellationId,
  type HostId,
  type ResourceLease,
  type SessionId,
  type WorkerLiveness,
  type WorkerPhase,
  type WorkerPhaseInput,
  type PhaseWaiting,
  workerPhase,
} from "@polaris/protocol";
import { RECENT_TURNS, type SessionRecord } from "../store/model.ts";
import { WORKERS_RESOURCE, type LeaseWaiter, type ResourcesModel } from "../resources/model.ts";
import type { ConstellationRecord } from "../store/constellation.ts";
import { workerWait } from "./waiting.ts";

/** One Host's `__workers` fold and the time it is read at; all folded state. */
export interface SlotSource {
  readonly hostId: HostId;
  readonly resources: ResourcesModel;
  readonly now: number;
  /** The Daemon's liveness per Attempt (the Desktop App's `firstTurn`); else the Session fold. */
  readonly liveness?: ReadonlyMap<AttemptId, WorkerLiveness>;
}

/** The Host facts a Lead needs to tell a stuck worker from a queued one. */
export interface HostSlots extends SlotSource {
  readonly constellations: ReadonlyMap<ConstellationId, ConstellationRecord>;
  readonly sessions: ReadonlyMap<SessionId, SessionRecord>;
}

const workerLeases = (resources: ResourcesModel): ReadonlyArray<ResourceLease> =>
  [...resources.leases.values()].filter((lease) => lease.resource === WORKERS_RESOURCE);

const workerWaiters = (resources: ResourcesModel): ReadonlyArray<LeaseWaiter> =>
  [...resources.waiting.values()].filter((waiter) => waiter.resource === WORKERS_RESOURCE);

/** The request is this Attempt's: by its id, or by its Session when the request names none. */
const isFor =
  (attempt: Attempt) =>
  (r: { readonly attemptId?: AttemptId | null; readonly sessionId?: SessionId | null }) =>
    r.attemptId === attempt.id || (r.attemptId == null && r.sessionId === attempt.sessionId);

/** The brief's Turn is in the fold, or a full window of later Turns pushed it out. */
export const briefStarted = (session: SessionRecord, attempt: Attempt): boolean =>
  session.turns.some((t) => t.id === `${attempt.id}:start`) ||
  (session.turns.length >= RECENT_TURNS && session.turns[0]!.startedAt >= attempt.startedAt);

/** This Attempt's `__workers` lease or queue entry on the Host whose fold this is. */
export const slotOf = (
  attempt: Attempt,
  host: SlotSource | undefined
): WorkerPhaseInput["slot"] => {
  if (host === undefined || attempt.hostId !== host.hostId) return null;
  const lease = workerLeases(host.resources).find(isFor(attempt));

  if (lease !== undefined) return { kind: "held", since: lease.acquiredAt };
  const waiter = workerWaiters(host.resources).find(isFor(attempt));

  return waiter === undefined ? null : { kind: "queued", since: waiter.queuedAt };
};

/** A working Attempt's phase through the shared `workerPhase`, as the Desktop App reads it. */
export const phaseOf = (
  record: ConstellationRecord,
  attempt: Attempt,
  session: SessionRecord,
  host?: SlotSource
): WorkerPhase => {
  const run = session.session.worktreeSetup;
  const constellationId = record.graph.id;

  return workerPhase({
    setup:
      run != null && run.constellationId === constellationId && run.taskId === attempt.taskId
        ? { status: run.status, startedAt: run.startedAt, endedAt: run.endedAt }
        : null,
    slot: slotOf(attempt, host),
    firstTurn: host?.liveness?.get(attempt.id)?.firstTurn ?? briefStarted(session, attempt),
    turnInFlight: session.turns.some((t) => t.status === "working"),
    startedAt: attempt.startedAt,
    now: host?.now ?? Date.now(),
    waiting: workerWait(record, attempt, session),
  });
};

/** "a command", "2 subagents", "1 subagent and 1 command", or what the worker said it waits on. */
export const waitingOnText = (waiting: PhaseWaiting): string => {
  const commands = waiting.tasks.filter((t) => t.kind === "command").length;
  const subagents = waiting.tasks.length - commands;
  const mixed = commands > 0 && subagents > 0;

  const counted = (noun: string, n: number) =>
    n === 1 && !mixed ? `a ${noun}` : `${n} ${noun}${n === 1 ? "" : "s"}`;

  const parts = [
    ...(subagents > 0 ? [counted("subagent", subagents)] : []),
    ...(commands > 0 ? [counted("command", commands)] : []),
  ];

  if (parts.length > 0) return parts.join(" and ");

  return waiting.on ?? "background work";
};

/** "40s", "12m", "1h05m": enough to spot an idle holder, short enough for every status. */
export const age = (since: string, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m`;

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
};

/** The phase in a few words; an age only when the Host's clock was read. */
export const phaseText = (phase: WorkerPhase, now: number | null): string => {
  const aged = (text: string, since: string) =>
    now === null ? text : `${text} ${age(since, now)}`;

  switch (phase.kind) {
    case "setup-running":
      return aged("setting up", phase.since);
    case "setup-failed":
      return "setup failed";
    case "waiting-for-slot":
      return aged("waiting for a slot", phase.since);
    case "starting":
      return aged("starting", phase.since);
    case "stalled":
      return aged("stalled", phase.since);
    case "working":
      return "Turn running";
    case "waiting-on-background":
      return aged(`waiting on ${waitingOnText(phase.waiting)}`, phase.waiting.since);
    case "idle":
      return "idle";
    case "unknown":
      return "unknown";
  }
};

const queuePlace = (attempt: Attempt, host: SlotSource | undefined) => {
  const waiters = host === undefined ? [] : workerWaiters(host.resources);
  const index = waiters.findIndex(isFor(attempt));

  return index === -1 ? "" : ` (${index + 1} of ${waiters.length})`;
};

const lastTurn = (attempt: Attempt, session: SessionRecord) => {
  const last = session.turns.findLast((t) => t.startedAt >= attempt.startedAt);

  return last === undefined
    ? ""
    : ` · last Turn ${last.status}${last.endedAt === null ? "" : ` at ${last.endedAt}`}`;
};

const heldFor = (attempt: Attempt, host: SlotSource | undefined) => {
  const slot = slotOf(attempt, host);

  return slot?.kind === "held" && host !== undefined
    ? ` · slot held ${age(slot.since, host.now)}`
    : "";
};

/** What it waits on, by name, and who ends the wait: its Harness, or the time it gave. */
const waitDetail = (waiting: PhaseWaiting, host: SlotSource | undefined) => {
  const named = waiting.tasks.map((t) => t.description).filter((d) => d !== "");
  const what = named.length === 0 ? "" : ` (${named.join("; ")})`;
  const declared = waiting.on !== null && waiting.tasks.length > 0 ? ` · said: ${waiting.on}` : "";

  const ends =
    host === undefined
      ? ""
      : ` · not stalled before ${new Date(waiting.until).toISOString().slice(11, 16)} UTC`;

  return `${what}${declared}${ends}`;
};

/** `Worker: <phase>` plus what tells it apart: queue place, last Turn, how long a slot is held. */
export const workerLine = (
  record: ConstellationRecord,
  attempt: Attempt,
  session: SessionRecord,
  host?: SlotSource
): string => {
  const phase = phaseOf(record, attempt, session, host);
  const head = `Worker: ${phaseText(phase, host?.now ?? null)}`;

  switch (phase.kind) {
    case "waiting-for-slot":
      return `${head}${queuePlace(attempt, host)}`;
    case "stalled":
      return `${head} · holds a slot, no Turn yet`;
    case "waiting-on-background":
      return `${head}${waitDetail(phase.waiting, host)}`;
    case "idle":
      return `${head}${lastTurn(attempt, session)}${heldFor(attempt, host)}`;
    default:
      return head;
  }
};

interface Owner {
  readonly record: ConstellationRecord;
  readonly attempt: Attempt;
}

const ownerOf = (
  host: HostSlots,
  attemptId: Attempt["id"] | null | undefined,
  sessionId: SessionId | null | undefined
): Owner | undefined => {
  const owners = [...host.constellations.values()].flatMap((record) =>
    record.graph.attempts
      .filter((a) => a.id === attemptId || a.sessionId === sessionId)
      .map((attempt) => ({ record, attempt }))
  );

  return (
    owners.find((o) => o.attempt.id === attemptId) ??
    owners.findLast((o) => o.attempt.endedAt == null) ??
    owners.at(-1)
  );
};

const ownerName = (
  owner: Owner | undefined,
  current: ConstellationId,
  sessionId: SessionId | null | undefined
) => {
  if (owner === undefined) return `session ${sessionId ?? "unknown"}`;

  const name =
    owner.record.graph.id === current
      ? owner.attempt.taskId
      : `${owner.record.graph.name}/${owner.attempt.taskId}`;

  // A slot held for an ended Attempt is the idle holder a Lead most needs to see.
  return owner.attempt.endedAt == null ? name : `${name} (${owner.attempt.state})`;
};

/** A holder's state in one word: the working Attempt's phase, else whether a Turn runs. */
const holderState = (host: HostSlots, owner: Owner | undefined, sessionId: SessionId | null) => {
  const session = sessionId === null ? undefined : host.sessions.get(sessionId);

  if (session?.turns.some((t) => t.status === "working") === true) return "running";

  if (owner?.attempt.state === "working" && session !== undefined) {
    const phase = phaseOf(owner.record, owner.attempt, session, host);

    if (phase.kind === "stalled" || phase.kind === "starting" || phase.kind === "idle")
      return phase.kind;
  }

  return "no Turn";
};

/**
 * One line for the Host's worker slots: each holder (this Constellation's by Task id, others as
 * name/Task), how long it has held and its state, then the FIFO waiters and how long each waited.
 */
export const slotLine = (host: HostSlots, current: ConstellationId): string | null => {
  const leases = workerLeases(host.resources);
  const waiters = workerWaiters(host.resources);

  if (leases.length === 0 && waiters.length === 0) return null;
  const cap = host.resources.resources.get(WORKERS_RESOURCE)?.capacity;

  const held = leases.map((lease) => {
    const owner = ownerOf(host, lease.attemptId, lease.sessionId);

    return `${ownerName(owner, current, lease.sessionId)} ${age(lease.acquiredAt, host.now)} ${holderState(host, owner, lease.sessionId ?? null)}`;
  });

  const queued = waiters.map(
    (w) =>
      `${ownerName(ownerOf(host, w.attemptId, w.sessionId), current, w.sessionId)} ${age(w.queuedAt, host.now)}`
  );

  return [
    `Host slots: ${leases.length}${cap === undefined ? "" : `/${cap}`} held`,
    ...held,
    ...(queued.length === 0 ? [] : [`waiting: ${queued.join(", ")}`]),
  ].join(" · ");
};
