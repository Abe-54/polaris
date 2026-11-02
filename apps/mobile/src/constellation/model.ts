/**
 * The constellation view's model (Paper C2, DESIGN.md Mobile App): the folded graph and its
 * Task projections become a task bar, a vertical rail of groups and tasks, and the claim
 * handed to the user. Pure; the screen renders it.
 */
import type {
  Attempt,
  CheckReceipt,
  Constellation,
  HarnessKind,
  Task,
  TaskProjection,
  TaskState,
  WorkerWaiting,
} from "@polaris/protocol";
import { liveQuestions } from "@polaris/protocol";
import { Match } from "effect";
import { elapsed, idRanges, shortSha } from "./copy.ts";

/** What one task is, at a glance: its glyph, its segment in the bar and its colour. */
export type Tone =
  | "done"
  | "working"
  | "review"
  | "needs-you"
  | "blocked"
  | "failed"
  | "waiting"
  | "ended";

export interface ConstellationSource {
  readonly constellation: Constellation;
  readonly projections: ReadonlyArray<TaskProjection>;
}

export interface Check {
  readonly label: string;
  /** Passed, failed, or reported without an exit code. */
  readonly result: "passed" | "failed" | "reported";
}

/** A claim the lead handed up to the user, waiting for Accept or Send back. */
export interface HandedClaim {
  readonly attemptId: string;
  readonly revision: number;
  readonly head: string;
  readonly checks: ReadonlyArray<Check>;
  /** The claim's question to the user, else its first question; null when it asks none. */
  readonly question: string | null;
  /** Why the lead handed it up, when it said. */
  readonly reason: string | null;
}

export type SecondLine =
  | { readonly kind: "activity"; readonly command: string; readonly elapsed: string }
  | { readonly kind: "after"; readonly ids: string }
  | { readonly kind: "claim"; readonly head: string; readonly checks: ReadonlyArray<Check> }
  | { readonly kind: "note"; readonly text: string };

export interface TaskRow {
  readonly kind: "task";
  readonly id: string;
  readonly title: string;
  readonly gate: boolean;
  readonly tone: Tone;
  readonly word: string;
  readonly harness: HarnessKind | null;
  /** "claude · opus 5" from the task's suggested worker, when it has one. */
  readonly worker: string | null;
  readonly second: SecondLine | null;
  readonly handed: HandedClaim | null;
  /** A gate's dependencies' tones, in order. */
  readonly deps: ReadonlyArray<Tone>;
}

export interface GroupRow {
  readonly kind: "group";
  readonly name: string;
  readonly total: number;
  readonly done: number;
  readonly needsYou: number;
  readonly working: number;
  readonly review: number;
  /** Every task in it is done or canceled: it folds unless the user opened it. */
  readonly finished: boolean;
  readonly open: boolean;
}

export type RailRow = GroupRow | TaskRow;

export interface TaskBar {
  readonly done: number;
  readonly total: number;
  /** One per task in declaration order, canceled and lost ones left out. */
  readonly segments: ReadonlyArray<Tone>;
  /** Each segment's Harness, for a working segment's hue. */
  readonly harnesses: ReadonlyArray<HarnessKind | null>;
}

export interface ConstellationView {
  readonly name: string;
  readonly state: Constellation["state"];
  readonly leadSessionId: string;
  readonly bar: TaskBar;
  readonly rows: ReadonlyArray<RailRow>;
  /** The task whose claim the lead is reviewing, if any ("Reviewing B2's claim"). */
  readonly reviewing: string | null;
}

const LIVE: ReadonlySet<TaskState> = new Set(["working", "blocked", "review"]);

const latestAttempt = (c: Constellation, p: TaskProjection | undefined): Attempt | null =>
  p?.latestAttemptId == null ? null : (c.attempts.find((a) => a.id === p.latestAttemptId) ?? null);

const userQuestion = (c: Constellation, attempt: Attempt | null): string | null => {
  if (attempt === null) return null;

  const open = liveQuestions(c.openQuestions, c.attempts).find(
    (q) => q.attemptId === attempt.id && q.question.to === "user"
  );

  return open?.question.text ?? null;
};

const isHanded = (attempt: Attempt | null, state: TaskState): attempt is Attempt =>
  attempt !== null &&
  state === "review" &&
  attempt.handedUpAt != null &&
  attempt.approvedByUserAt == null &&
  attempt.claim != null;

const TONE_OF_STATE: Readonly<Record<TaskState, Tone>> = {
  waiting: "waiting",
  ready: "waiting",
  working: "working",
  blocked: "blocked",
  review: "review",
  done: "done",
  canceled: "ended",
  lost: "ended",
  failed: "failed",
};

const WORD_OF_STATE: Readonly<Record<TaskState, string>> = {
  waiting: "waiting",
  ready: "ready",
  working: "working",
  blocked: "blocked",
  review: "in review",
  done: "done",
  canceled: "canceled",
  lost: "lost",
  failed: "failed",
};

const reportedResult = (exitCode: number | null | undefined): Check["result"] => {
  if (exitCode == null) return "reported";

  return exitCode === 0 ? "passed" : "failed";
};

const checkOf = (receipt: CheckReceipt): Check =>
  Match.value(receipt).pipe(
    Match.tag("Verified", (r) => ({ label: r.label, result: "passed" as const })),
    Match.tag("Reported", (r) => ({ label: r.label, result: reportedResult(r.exitCode) })),
    Match.exhaustive
  );

const handedClaim = (c: Constellation, attempt: Attempt): HandedClaim | null => {
  const { claim } = attempt;

  if (claim == null) return null;
  const toUser = claim.questions.find((q) => q.to === "user") ?? claim.questions[0];

  return {
    attemptId: attempt.id,
    revision: attempt.revision,
    head: shortSha(claim.head),
    checks: claim.receipts.map(checkOf),
    question: userQuestion(c, attempt) ?? toUser?.text ?? null,
    reason: attempt.handedUpReason,
  };
};

const workerOf = (task: Task): string | null => {
  const suggested = task.suggested;

  if (suggested == null || suggested.harness === undefined) return null;

  return suggested.model === undefined
    ? suggested.harness
    : `${suggested.harness} · ${suggested.model}`;
};

/** "waiting on a command", "waiting on 2 subagents", or what the worker said it waits on. */
const waitingWords = (waiting: WorkerWaiting): string => {
  const commands = waiting.tasks.filter((t) => t.kind === "command").length;
  const subagents = waiting.tasks.length - commands;
  const mixed = commands > 0 && subagents > 0;

  const counted = (noun: string, n: number) =>
    n === 1 && !mixed ? `a ${noun}` : `${n} ${noun}${n === 1 ? "" : "s"}`;

  const parts = [
    ...(subagents > 0 ? [counted("subagent", subagents)] : []),
    ...(commands > 0 ? [counted("command", commands)] : []),
  ];

  return `waiting on ${parts.length > 0 ? parts.join(" and ") : (waiting.on ?? "background work")}`;
};

const secondLine = (
  task: Task,
  p: TaskProjection,
  attempt: Attempt | null,
  now: number
): SecondLine | null => {
  const current = p.liveness?.current ?? null;

  if (p.state === "working" && current !== null)
    return { kind: "activity", command: current.command, elapsed: elapsed(current.startedAt, now) };

  const waiting = p.liveness?.waiting ?? null;

  // Waiting on Background Work (ENG-742): neutral, what it waits on and for how long.
  if (
    p.state === "working" &&
    p.liveness?.activeTurn === false &&
    waiting !== null &&
    now < waiting.until
  )
    return {
      kind: "note",
      text: `${waitingWords(waiting)} · ${elapsed(Date.parse(waiting.since), now)}`,
    };

  if (p.state === "working" && attempt !== null)
    return { kind: "note", text: `started ${elapsed(Date.parse(attempt.startedAt), now)} ago` };

  if (p.state === "blocked" && attempt?.blockedReason != null)
    return { kind: "note", text: attempt.blockedReason };

  if (p.state === "review" && attempt?.claim != null)
    return {
      kind: "claim",
      head: shortSha(attempt.claim.head),
      checks: attempt.claim.receipts.map(checkOf),
    };

  if ((p.state === "waiting" || p.state === "ready") && p.blockedBy.length > 0)
    return { kind: "after", ids: idRanges(p.blockedBy) };

  if (task.kind === "gate" && task.deps.length > 0 && p.state !== "done")
    return { kind: "after", ids: idRanges(task.deps) };

  return null;
};

const wordOf = (task: Task, p: TaskProjection, handed: boolean, asks: boolean): string => {
  if (handed) return "handed to you";

  if (asks) return "asks you";

  // A gate is the lead's own work: it waits on its dependencies, then the lead carries it.
  if (task.kind === "gate" && (p.state === "waiting" || p.state === "ready")) return "lead";

  return WORD_OF_STATE[p.state];
};

export const taskRow = (
  c: Constellation,
  task: Task,
  projections: ReadonlyMap<string, TaskProjection>,
  now: number
): TaskRow | null => {
  const p = projections.get(task.id);

  if (p === undefined) return null;
  const attempt = latestAttempt(c, p);
  const handed = isHanded(attempt, p.state) ? handedClaim(c, attempt) : null;
  const asks = LIVE.has(p.state) && userQuestion(c, attempt) !== null;
  const tone: Tone = handed !== null || asks ? "needs-you" : TONE_OF_STATE[p.state];

  return {
    kind: "task",
    id: task.id,
    title: task.title,
    gate: task.kind === "gate",
    tone,
    word: wordOf(task, p, handed !== null, asks),
    harness: task.suggested?.harness ?? null,
    worker: workerOf(task),
    second: handed === null ? secondLine(task, p, attempt, now) : null,
    handed,
    // Filled in once every row has its tone (`withGateDeps`).
    deps: [],
  };
};

const groupRow = (name: string, rows: ReadonlyArray<TaskRow>, open: boolean | undefined) => {
  const counted = rows.filter((r) => r.tone !== "ended");
  const count = (tone: Tone) => counted.filter((r) => r.tone === tone).length;
  const finished = counted.every((r) => r.tone === "done");

  return {
    kind: "group" as const,
    name,
    total: counted.length,
    done: count("done"),
    needsYou: count("needs-you"),
    working: count("working"),
    review: count("review"),
    finished,
    open: open ?? !finished,
  };
};

/** Tasks in declaration order; grouped ones gather under their group where it first appears. */
const railRows = (
  c: Constellation,
  rows: ReadonlyArray<TaskRow>,
  opened: ReadonlyMap<string, boolean>
): ReadonlyArray<RailRow> => {
  const groupOf = new Map<string, string | null>(c.tasks.map((t) => [t.id, t.group ?? null]));
  const out: Array<RailRow> = [];
  const placed = new Set<string>();

  for (const row of rows) {
    const name = groupOf.get(row.id) ?? null;

    if (name === null) {
      out.push(row);
      continue;
    }

    if (placed.has(name)) continue;
    placed.add(name);
    const members = rows.filter((r) => groupOf.get(r.id) === name);
    const group = groupRow(name, members, opened.get(name));

    out.push(group, ...(group.open ? members : []));
  }

  return out;
};

/** A gate's dependencies take their rows' tones, so a handed-up claim shows as needs you. */
const withGateDeps = (c: Constellation, rows: ReadonlyArray<TaskRow>): ReadonlyArray<TaskRow> => {
  const toneOf = new Map(rows.map((r) => [r.id, r.tone]));
  const depsOf = new Map<string, ReadonlyArray<string>>(c.tasks.map((t) => [t.id, t.deps]));

  return rows.map((r) =>
    r.gate ? { ...r, deps: (depsOf.get(r.id) ?? []).map((id) => toneOf.get(id) ?? "waiting") } : r
  );
};

export const taskBar = (rows: ReadonlyArray<Pick<TaskRow, "tone" | "harness">>): TaskBar => {
  const counted = rows.filter((r) => r.tone !== "ended");

  return {
    done: counted.filter((r) => r.tone === "done").length,
    total: counted.length,
    segments: counted.map((r) => r.tone),
    harnesses: counted.map((r) => r.harness),
  };
};

const reviewingTask = (rows: ReadonlyArray<TaskRow>): string | null =>
  rows.find((r) => r.tone === "review" && r.second?.kind === "claim")?.id ?? null;

export const constellationView = (
  source: ConstellationSource,
  now: number,
  opened: ReadonlyMap<string, boolean> = new Map()
): ConstellationView => {
  const { constellation: c } = source;
  const projections = new Map(source.projections.map((p) => [p.taskId, p]));

  // A parent task is a container: its children carry the work, so it has no row of its own.
  const parents = new Set(c.tasks.flatMap((t) => (t.parent == null ? [] : [t.parent])));

  const rows = withGateDeps(
    c,
    c.tasks.flatMap((t) => (parents.has(t.id) ? [] : (taskRow(c, t, projections, now) ?? [])))
  );

  return {
    name: c.name,
    state: c.state,
    leadSessionId: c.leadSessionId,
    bar: taskBar(rows),
    rows: railRows(c, rows, opened),
    reviewing: reviewingTask(rows),
  };
};
