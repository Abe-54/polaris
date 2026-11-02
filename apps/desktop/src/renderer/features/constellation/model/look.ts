/**
 * How one Task reads at a glance (DESIGN.md, rule/constellation-colour): its rail glyph, the
 * colour of its id and state word, and whether it needs you.
 */
import type { TaskState } from "@polaris/protocol";
import { idRanges, span } from "./copy.ts";
import { neutralFailure } from "./failure.ts";
import type { Facts, WorkerFacts } from "./facts.ts";
import type { WorkerPhase } from "@polaris/protocol";
import { phaseOf } from "./phase.ts";
import { userQuestions } from "./questions.ts";
import { waitingWords } from "./waiting.ts";
import { currentSetup, type SetupRun } from "./setup.ts";
import type { AttemptData, ConstellationData, ProjectionData, TaskData } from "./types.ts";

export type TaskGlyphKind =
  | "working"
  | "blocked"
  | "review"
  | "review-unfetched"
  | "needs-you"
  | "accepted"
  | "waiting"
  | "future"
  | "gate"
  | "gate-accepted"
  | "failed"
  | "stopped";

export type Tone = "neutral" | "accepted" | "needs-you" | "failed" | "faint";

/** Why a Task needs you, in the order Needs you ranks them (spec §5). */
export type Attention =
  | { readonly kind: "approval"; readonly since: string; readonly secret?: boolean }
  | { readonly kind: "question"; readonly text: string }
  | { readonly kind: "handed" }
  | { readonly kind: "stopped" }
  /** Worktree setup failed before the Attempt could start (it ranks with "stopped"). */
  | { readonly kind: "setup"; readonly run: SetupRun }
  /** It holds a worker slot with no first Turn and nothing running (ENG-264): start it. */
  | { readonly kind: "stalled"; readonly since: string };

/** The buckets groups count and filters use. */
export type Bucket = "needs-you" | "review" | "working" | "blocked" | "done" | "waiting" | "ended";

export interface TaskLook {
  readonly glyph: TaskGlyphKind;
  readonly idTone: Tone;
  readonly word: string;
  readonly wordTone: Tone;
  /** "verified", "reported" or "asserted" after "done". */
  readonly evidence: string | null;
  readonly attention: Attention | null;
  readonly bucket: Bucket;
}

const ENDED: ReadonlySet<TaskState> = new Set(["canceled", "lost"]);

/** The rail glyph for a projection; shared with the sidebar's worker rows. */
export const glyphFor = (
  projection: Pick<ProjectionData, "state" | "branchFetched">,
  options: { readonly needsYou: boolean; readonly isGate: boolean }
): TaskGlyphKind => {
  const { state } = projection;

  if (options.needsYou) return "needs-you";

  if (options.isGate && state === "done") return "gate-accepted";

  if (options.isGate && state !== "working" && state !== "review") return "gate";

  if (state === "done") return "accepted";

  if (state === "working") return "working";

  if (state === "blocked") return "blocked";

  if (state === "review") return projection.branchFetched ? "review" : "review-unfetched";

  if (state === "failed") return "failed";

  if (ENDED.has(state)) return "stopped";

  return "waiting";
};

/** The question to the user a Task's latest Attempt is waiting on, if any. */
export const userQuestion = (c: ConstellationData, attemptId: string | null) => {
  if (attemptId === null) return null;

  return userQuestions(c).find((q) => q.attemptId === attemptId)?.question.text ?? null;
};

const attentionOf = (
  c: ConstellationData,
  projection: ProjectionData,
  attempt: AttemptData | null,
  worker: WorkerFacts,
  phase: WorkerPhase | null
): Attention | null => {
  if (
    attempt === null ||
    (projection.state !== "working" &&
      projection.state !== "blocked" &&
      projection.state !== "review")
  )
    return null;

  if (worker.approvalSince !== null)
    return worker.approvalSecret === true
      ? { kind: "approval", since: worker.approvalSince, secret: true }
      : { kind: "approval", since: worker.approvalSince };
  const question = userQuestion(c, attempt.id);

  if (question !== null) return { kind: "question", text: question };

  if (
    projection.state === "review" &&
    attempt.handedUpAt != null &&
    attempt.approvedByUserAt == null
  )
    return { kind: "handed" };

  if (projection.state !== "working") return null;

  // Waiting on Background Work is never stopped, whatever the session's idle state says.
  if (worker.stoppedWithoutClaiming && phase?.kind !== "waiting-on-background")
    return { kind: "stopped" };

  return phase?.kind === "stalled" ? { kind: "stalled", since: phase.since } : null;
};

const ATTENTION_WORD: Readonly<Record<Attention["kind"], string>> = {
  approval: "needs you",
  question: "asks you",
  handed: "handed to you",
  stopped: "needs you",
  setup: "setup failed",
  stalled: "stalled",
};

/** "stalled · 12m" counts from when it took the slot; the others need no age. */
const attentionWord = (attention: Attention, now: number) =>
  attention.kind === "stalled"
    ? `${ATTENTION_WORD.stalled} · ${span(attention.since, now)}`
    : ATTENTION_WORD[attention.kind];

const STATE_WORD: Readonly<Record<TaskState, string>> = {
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

const BUCKET: Readonly<Record<TaskState, Bucket>> = {
  waiting: "waiting",
  ready: "waiting",
  working: "working",
  blocked: "blocked",
  review: "review",
  done: "done",
  canceled: "ended",
  lost: "ended",
  failed: "ended",
};

const wordFor = (task: TaskData, p: ProjectionData, attempt: AttemptData | null, now: number) => {
  if (p.state === "working" && attempt !== null) return `working · ${span(attempt.startedAt, now)}`;

  if (task.kind === "gate" && (p.state === "waiting" || p.state === "ready"))
    return p.blockedBy.length > 0 ? `after ${idRanges(p.blockedBy)}` : "ready";

  return STATE_WORD[p.state];
};

/** A state's tone, for the id and word (and a blocked row's "blocked by" ids). */
export const toneOf = (state: TaskState): Tone => {
  if (state === "done") return "accepted";

  if (state === "failed") return "failed";

  return ENDED.has(state) ? "faint" : "neutral";
};

/** Setup runs on the Host outside the worker cap: neutral while running, needs you once failed. */
const setupLook = (run: SetupRun, failed: boolean): TaskLook =>
  failed
    ? {
        glyph: "needs-you",
        idTone: "needs-you",
        word: ATTENTION_WORD.setup,
        wordTone: "needs-you",
        evidence: null,
        attention: { kind: "setup", run },
        bucket: "needs-you",
      }
    : {
        glyph: "waiting",
        idTone: "neutral",
        word: "setting up",
        wordTone: "neutral",
        evidence: null,
        attention: null,
        bucket: "working",
      };

const waitingLook = (word: string, bucket: Bucket): TaskLook => ({
  glyph: "waiting",
  idTone: "neutral",
  word,
  wordTone: "neutral",
  evidence: null,
  attention: null,
  bucket,
});

/** A working Attempt not running a Turn: queued for a slot, starting, or waiting (F9). */
const quietLook = (
  attempt: AttemptData,
  worker: WorkerFacts,
  phase: WorkerPhase | null,
  now: number
): TaskLook | null => {
  if (worker.activity?.kind === "slot")
    return waitingLook(`waiting · ${span(worker.activity.since, now)}`, "working");

  // Its Harness has work out: neutral, counted as working (ENG-742).
  if (phase?.kind === "waiting-on-background")
    return waitingLook(
      `${waitingWords(phase.waiting)} · ${span(phase.waiting.since, now)}`,
      "working"
    );

  // No first Turn yet: on its way to work, not waiting on anyone (ENG-264).
  if (phase?.kind === "starting")
    return waitingLook(`starting · ${span(phase.since, now)}`, "working");

  return worker.activeTurn === false
    ? waitingLook(`waiting · ${span(worker.quietSince ?? attempt.startedAt, now)}`, "waiting")
    : null;
};

export const taskLook = (
  c: ConstellationData,
  task: TaskData,
  projection: ProjectionData,
  attempt: AttemptData | null,
  facts: Facts
): TaskLook => {
  const setup = currentSetup(facts.setup(task.id), attempt);

  if (setup !== null) return setupLook(setup.run, setup.failed);
  const worker = attempt === null ? null : facts.worker(attempt);

  const phase =
    attempt === null || worker === null || projection.state !== "working"
      ? null
      : phaseOf(attempt, worker, facts.setup(task.id), facts.now);

  const attention = worker === null ? null : attentionOf(c, projection, attempt, worker, phase);
  const isGate = task.kind === "gate";
  const glyph = glyphFor(projection, { needsYou: attention !== null, isGate });

  if (attention !== null)
    return {
      glyph,
      idTone: "needs-you",
      word: attentionWord(attention, facts.now),
      wordTone: "needs-you",
      evidence: null,
      attention,
      bucket: "needs-you",
    };

  const quiet =
    projection.state === "working" && attempt !== null && worker !== null
      ? quietLook(attempt, worker, phase, facts.now)
      : null;

  if (quiet !== null) return quiet;

  if (projection.state === "failed" && neutralFailure(attempt?.failureKind))
    return {
      glyph: "stopped",
      idTone: "neutral",
      word: attempt?.failureKind === "capacity" ? "usage limit" : "failed",
      wordTone: "neutral",
      evidence: null,
      attention: null,
      bucket: BUCKET.failed,
    };
  const tone = toneOf(projection.state);

  return {
    glyph,
    idTone: tone === "faint" ? "faint" : tone,
    word: wordFor(task, projection, attempt, facts.now),
    wordTone: tone,
    evidence: projection.state === "done" ? (attempt?.evidence ?? null) : null,
    attention: null,
    bucket: BUCKET[projection.state],
  };
};
