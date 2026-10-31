/**
 * One Task's rail row: the look, the actor lane, and the one or two caption lines that carry
 * state (liveness, the Claim at a glance, a Gate's receipts, why it needs you, an overlap).
 */
import type { HarnessKind, TaskId } from "@polaris/protocol";
import { Match } from "effect";
import type { Overlap } from "./areas.ts";
import { acceptedGlance, type ClaimGlance, claimGlance, type ReceiptView } from "./claim.ts";
import { actorLine, harnessWord, span } from "./copy.ts";
import { failureNote, neutralFailure } from "./failure.ts";
import { type Activity, CONTEXT_WARN, type Facts, NO_FACTS, type WorkerFacts } from "./facts.ts";
import {
  glyphFor,
  type TaskGlyphKind,
  type TaskLook,
  taskLook,
  type Tone,
  toneOf,
} from "./look.ts";
import type { WorkerPhase } from "@polaris/protocol";
import { phaseOf } from "./phase.ts";
import { currentSetup, type SetupFact } from "./setup.ts";
import type {
  AttemptData,
  ConstellationRecord,
  ProjectionData,
  Progress,
  TaskData,
} from "./types.ts";

export interface Liveness {
  readonly kind: "liveness";
  /** "bun run bench" (mono) or "waiting on bench (held by B2)". */
  readonly activity: string | null;
  readonly mono: boolean;
  readonly duration: string | null;
  readonly context: number | null;
  readonly queued: number;
  /** The worker's own progress note, "3/8 · writing properties". */
  readonly progress: string | null;
  /** The worker's Host is away: "devbox reconnecting". */
  readonly away: string | null;
  /** No command running and no output for a while: "quiet 3m". */
  readonly quiet: string | null;
  /** The Daemon says no Turn is in flight: "waiting, not working". */
  readonly idle: boolean;
}

export type Line =
  | Liveness
  | { readonly kind: "claim"; readonly glance: ClaimGlance }
  | {
      readonly kind: "accepted";
      readonly head: string;
      readonly receipts: ReadonlyArray<ReceiptView>;
    }
  | {
      /** "setting up · bun install · 1m", or a failed run's "bun install exited 1". */
      readonly kind: "setup";
      readonly failed: boolean;
      readonly command: string;
      readonly exitCode: number | null;
      readonly duration: string;
      /** The worker's Host when it isn't the Lead's: "on devbox". */
      readonly remoteHost: string | null;
    }
  | {
      /** "blocked by F1b" (each id in its state's tone), or "waiting on the lead"; the reason. */
      readonly kind: "blocked";
      readonly on: ReadonlyArray<{ readonly id: string; readonly tone: Tone }>;
      readonly reason: string | null;
    }
  | {
      readonly kind: "note";
      readonly text: string;
      readonly tone: "neutral" | "needs-you";
      readonly detail: string | null;
    };

export interface GateInput {
  readonly taskId: string;
  readonly glyph: TaskGlyphKind;
  readonly harness: HarnessKind | null;
}

export interface TaskRow {
  readonly kind: "task";
  readonly key: string;
  readonly task: TaskData;
  readonly attempt: AttemptData | null;
  /** One-based among this Task's Attempts. */
  readonly attemptNumber: number;
  readonly projection: ProjectionData;
  readonly look: TaskLook;
  readonly harness: HarnessKind | null;
  readonly actor: string;
  readonly line: Line | null;
  /** Worktree setup running or failed ahead of the next Attempt; Retry and the log use it. */
  readonly setup: SetupFact | null;
  readonly overlap: Overlap | null;
  /** A Gate's inputs, each in its own state (a working one in its Harness hue). */
  readonly inputs: ReadonlyArray<GateInput> | null;
  /** Accept / Send back as buttons: the Constellation is paused or the Claim was handed up. */
  readonly promoted: boolean;
  /** Nested under a group or parent (not on the trunk). */
  readonly nested: boolean;
  /** Where it hangs in the tree: depth and which ancestor lines run past it. */
  readonly tree: TreeLane;
  /** Tasks whose blocked Attempt waits on this one: "blocks F2". */
  readonly blocks: ReadonlyArray<string>;
  /** Its own deps other than the one it hangs under on the rail: "← M, X". */
  readonly also: ReadonlyArray<{ readonly id: string; readonly tone: Tone }>;
}

/** A row's place in the rail (`git log --graph`): 0 is the trunk. */
export interface TreeLane {
  readonly depth: number;
  /** For each level 1…depth-1, whether that level's line runs on below this row. */
  readonly through: ReadonlyArray<boolean>;
  /** The last child of its parent: the elbow ends here. */
  readonly last: boolean;
  /** An open parent: its children's line starts under its glyph. */
  readonly down: boolean;
}

export const TRUNK: TreeLane = { depth: 0, through: [], last: false, down: false };

const progressText = (p: Progress | undefined) => {
  if (p === undefined) return null;
  const count = p.completed !== null && p.total !== null ? `${p.completed}/${p.total}` : null;

  return [count, p.note].filter((x) => x !== null && x !== "").join(" · ") || null;
};

const awayText = (w: WorkerFacts) =>
  w.hostAway === null || w.remoteHost === null ? null : `${w.remoteHost} ${w.hostAway}`;

const QUIET_AFTER_MS = 60_000;

/** "quiet 3m" once a worker has been silent past a minute. */
const quietFor = (since: string, now: number) =>
  now - Date.parse(since) < QUIET_AFTER_MS ? null : `quiet ${span(since, now)}`;

const activityText = (a: Activity) =>
  Match.value(a).pipe(
    Match.discriminatorsExhaustive("kind")({
      command: ({ text }) => text,
      tool: ({ text }) => text,
      slot: ({ host }) => `waiting for a slot${host === null ? "" : ` on ${host}`}`,
      lease: ({ resource, holder }) =>
        `waiting on ${resource}${holder === null ? "" : ` (held by ${holder})`}`,
    })
  );

const liveness = (w: WorkerFacts, progress: Progress | undefined, now: number): Liveness | null => {
  const a = w.activity;

  const activity = a === null ? null : activityText(a);

  const line: Liveness = {
    kind: "liveness",
    activity,
    mono: a !== null && (a.kind === "command" || a.kind === "tool"),
    duration: a === null ? null : span(a.since, now),
    context: w.contextPercent,
    queued: w.queued,
    progress: progressText(progress),
    away: awayText(w),
    quiet: a === null && w.quietSince !== null ? quietFor(w.quietSince, now) : null,
    idle: w.activeTurn === false,
  };

  const empty =
    !line.idle &&
    activity === null &&
    line.progress === null &&
    line.away === null &&
    line.quiet === null;

  return empty && (w.contextPercent ?? 0) < CONTEXT_WARN && w.queued === 0 ? null : line;
};

interface LineInput {
  readonly row: Pick<TaskRow, "task" | "attempt" | "projection" | "look">;
  readonly worker: WorkerFacts;
  readonly record: ConstellationRecord;
  readonly facts: Facts;
  readonly tone: (id: TaskId) => Tone;
}

const blockedLine = (attempt: AttemptData, tone: LineInput["tone"]): Line => ({
  kind: "blocked",
  on: attempt.blockedOn.map((id) => ({ id, tone: tone(id) })),
  reason: attempt.blockedReason ?? null,
});

const reviewLine = ({ row, worker, facts }: LineInput): Line | null => {
  if (!row.projection.branchFetched)
    return {
      kind: "note",
      text: "review · branch not yet fetched",
      tone: "neutral",
      detail: awayText(worker),
    };
  const claim = row.attempt?.claim;

  return claim == null
    ? null
    : {
        kind: "claim",
        glance: claimGlance(claim, facts, row.attempt?.approvedByUserAt ?? null),
      };
};

/** "resets 14:00" for a usage limit, else the failure's kind; the Harness's reason after it. */
const failedLine = (attempt: AttemptData): Line | null => {
  const kind = attempt.failureKind ?? null;
  const reason = attempt.settleReason ?? null;

  if (kind === null && reason === null) return null;

  if (kind === null) return { kind: "note", text: reason ?? "", tone: "neutral", detail: null };

  return {
    kind: "note",
    text: failureNote(kind, attempt.resetsAt),
    tone: "neutral",
    detail: reason,
  };
};

/** "setup done · starting its first turn", or a stalled worker's "holds a slot, no turn yet". */
const startupLine = (phase: WorkerPhase): Line | null => {
  if (phase.kind !== "starting" && phase.kind !== "stalled") return null;
  const done = phase.setupDone ? "setup done · " : "";

  if (phase.kind === "stalled")
    return {
      kind: "note",
      text: `${done}holds a slot, no turn yet`,
      tone: "neutral",
      detail: null,
    };

  return {
    kind: "note",
    text: phase.afterTurn
      ? `${done}starting after the current turn`
      : `${done}starting its first turn`,
    tone: "neutral",
    detail: null,
  };
};

const approvalNote = (secret: boolean | undefined) =>
  secret === true ? "asking for a secret" : "waiting on your approval";

const lineFor = (input: LineInput): Line | null => {
  const { row, worker, record, facts } = input;
  const { attention } = row.look;

  if (attention?.kind === "approval")
    return {
      kind: "note",
      text: `${approvalNote(attention.secret)} · ${span(attention.since, facts.now)}`,
      tone: "neutral",
      detail: null,
    };

  if (attention?.kind === "stopped")
    return {
      kind: "note",
      text: "stopped without reporting back",
      tone: "neutral",
      detail: "reminded once",
    };

  if (attention?.kind === "question")
    return { kind: "note", text: attention.text, tone: "needs-you", detail: null };

  if (row.projection.state === "blocked" && row.attempt !== null)
    return blockedLine(row.attempt, input.tone);

  if (row.projection.state === "review") return reviewLine(input);

  if (row.projection.state === "working" && row.attempt !== null)
    return (
      startupLine(phaseOf(row.attempt, worker, facts.setup(row.task.id), facts.now)) ??
      liveness(worker, record.progress.get(row.attempt.id), facts.now)
    );

  if (row.projection.state === "failed" && row.attempt !== null) return failedLine(row.attempt);

  if (row.task.kind === "gate" && row.projection.state === "done" && row.attempt !== null) {
    const glance = acceptedGlance(row.attempt, facts);

    return glance === null ? null : { kind: "accepted", ...glance };
  }

  return null;
};

const setupLine = (setup: SetupFact, now: number): Line => ({
  kind: "setup",
  failed: setup.failed,
  command: setup.run.command,
  exitCode: setup.run.exitCode,
  duration: span(setup.run.startedAt, now),
  remoteHost: setup.remoteHost,
});

const rowLine = (input: LineInput, setup: SetupFact | null, oneLine: boolean): Line | null => {
  if (oneLine) return null;

  if (setup !== null) return setupLine(setup, input.facts.now);

  return input.row.attempt === null && input.row.task.kind !== "gate" ? null : lineFor(input);
};

export interface TaskContext {
  readonly record: ConstellationRecord;
  readonly facts: Facts;
  readonly projections: ReadonlyMap<TaskId, ProjectionData>;
  readonly attempts: ReadonlyMap<TaskId, ReadonlyArray<AttemptData>>;
  readonly overlaps: ReadonlyMap<TaskId, Overlap>;
  readonly tasks: ReadonlyMap<TaskId, TaskData>;
  /** For each Task, the Tasks whose blocked Attempt names it. */
  readonly blocks: ReadonlyMap<TaskId, ReadonlyArray<TaskId>>;
  /** Rows drop to one line (large Constellations). */
  readonly oneLine: boolean;
}

/** A Task the Daemon hasn't projected yet reads as waiting. */
const unprojected = (taskId: TaskId): ProjectionData => ({
  taskId,
  state: "waiting",
  latestAttemptId: null,
  blockedBy: [],
  children: [],
  gatePromoted: false,
  stale: false,
  branchFetched: true,
  liveness: null,
});

const toneOfTask = (id: TaskId, ctx: TaskContext): Tone =>
  toneOf(ctx.projections.get(id)?.state ?? "waiting");

const inputGlyphs = (task: TaskData, ctx: TaskContext): ReadonlyArray<GateInput> =>
  task.deps.map((dep) => {
    const p = ctx.projections.get(dep) ?? unprojected(dep);
    const attempt = ctx.attempts.get(dep)?.at(-1);

    const harness =
      (attempt === undefined ? null : ctx.facts.worker(attempt).harness) ??
      ctx.tasks.get(dep)?.suggested?.harness ??
      null;

    return {
      taskId: dep,
      glyph:
        p.state === "failed" && neutralFailure(attempt?.failureKind)
          ? "stopped"
          : glyphFor(p, { needsYou: false, isGate: ctx.tasks.get(dep)?.kind === "gate" }),
      harness,
    };
  });

const actorFor = (
  task: TaskData,
  attempt: AttemptData | null,
  w: WorkerFacts,
  ctx: TaskContext
) => {
  if (task.kind === "gate") return actorLine("lead", ctx.facts.lead.model, null);

  if (attempt === null)
    return actorLine(
      harnessWord(task.suggested?.harness ?? null),
      task.suggested?.model ?? null,
      null
    );

  return actorLine(harnessWord(w.harness), w.model, w.remoteHost);
};

export const taskRow = (
  task: TaskData,
  nested: boolean,
  ctx: TaskContext,
  tree: TreeLane = TRUNK
): TaskRow => {
  const { record, facts } = ctx;
  const projection = ctx.projections.get(task.id) ?? unprojected(task.id);
  const history = ctx.attempts.get(task.id) ?? [];
  const attempt = history.at(-1) ?? null;
  const worker = attempt === null ? null : facts.worker(attempt);
  const look = taskLook(record.constellation, task, projection, attempt, facts);
  const known = worker ?? NO_FACTS;
  const base = { task, attempt, projection, look };
  const setup = currentSetup(facts.setup(task.id), attempt);

  return {
    kind: "task",
    key: `task:${task.id}`,
    ...base,
    attemptNumber: history.length,
    harness:
      task.kind === "gate"
        ? ctx.facts.lead.harness
        : (worker?.harness ?? task.suggested?.harness ?? null),
    actor: actorFor(task, attempt, known, ctx),
    line: rowLine(
      { row: base, worker: known, record, facts, tone: (id) => toneOfTask(id, ctx) },
      setup,
      ctx.oneLine
    ),
    setup,
    overlap: ctx.oneLine ? null : (ctx.overlaps.get(task.id) ?? null),
    inputs: task.kind === "gate" ? inputGlyphs(task, ctx) : null,
    promoted:
      projection.state === "review" &&
      (record.constellation.state === "paused" || look.attention?.kind === "handed"),
    nested,
    tree,
    blocks: ctx.oneLine ? [] : (ctx.blocks.get(task.id) ?? []),
    also: [],
  };
};
