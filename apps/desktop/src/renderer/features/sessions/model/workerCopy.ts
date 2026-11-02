/** How a worker row reads: its glyph, its state word and that word's tone (rule/constellation-colour). */
import type { TaskGlyphKind } from "../glyphs.tsx";
import { failedText, neutralFailure } from "../../constellation/model/failure.ts";
import { setupExit } from "../../constellation/model/setup.ts";
import { waitingDetail, waitingWords } from "../../constellation/model/waiting.ts";
import type { PhaseWaiting } from "@polaris/protocol";
import type { LeadWorker, WorkerState } from "./leadGroups.ts";

export type WorkerTone = "needs-you" | "accepted" | "failed" | "subtle";

interface Shown {
  readonly glyph: TaskGlyphKind;
  /** Null shows the Attempt's age instead. */
  readonly word: string | null;
  readonly tone: WorkerTone;
}

const SHOWN: Readonly<Record<WorkerState, Shown>> = {
  blocked: { glyph: "blocked", word: "blocked", tone: "subtle" },
  "needs-you": { glyph: "needs-you", word: "needs you", tone: "needs-you" },
  unclaimed: { glyph: "needs-you", word: "stopped", tone: "needs-you" },
  stale: { glyph: "needs-you", word: "stale", tone: "needs-you" },
  review: { glyph: "review", word: "review", tone: "subtle" },
  "handed-up": { glyph: "review", word: "handed to you", tone: "needs-you" },
  working: { glyph: "working", word: null, tone: "subtle" },
  "waiting-slot": { glyph: "waiting", word: "waiting", tone: "subtle" },
  "waiting-background": { glyph: "waiting", word: "waiting", tone: "subtle" },
  "sent-back": { glyph: "waiting", word: "sent back", tone: "subtle" },
  failed: { glyph: "failed", word: "failed", tone: "failed" },
  lost: { glyph: "stopped", word: "lost", tone: "subtle" },
  accepted: { glyph: "accepted", word: "done", tone: "accepted" },
  "setting-up": { glyph: "waiting", word: "setting up", tone: "subtle" },
  "setup-failed": { glyph: "needs-you", word: "setup failed", tone: "needs-you" },
  starting: { glyph: "waiting", word: "starting", tone: "subtle" },
  stalled: { glyph: "needs-you", word: "stalled", tone: "needs-you" },
};

/** A usage limit, connection or harness failure isn't the worker's: "Usage limit · resets 14:00", neutral. */
const neutralShown = (row: LeadWorker): Shown | null =>
  row.kind === "attempt" && row.state === "failed" && neutralFailure(row.attempt.failureKind)
    ? {
        glyph: "stopped",
        word: failedText(row.attempt.failureKind, row.attempt.resetsAt),
        tone: "subtle",
      }
    : null;

export const shownWorker = (row: LeadWorker): Shown => {
  const shown = SHOWN[row.state];

  if (row.kind === "attempt" && row.state === "review" && !row.fetched)
    return { ...shown, glyph: "review-unfetched" };

  return neutralShown(row) ?? shown;
};

/** A setup row's hover: "setting up · bun install · 1m", or "bun install exited 1". */
export const setupHover = (
  setup: { readonly command: string; readonly exitCode: number | null },
  failed: boolean,
  age: string
) => (failed ? `${setup.command} ${setupExit(setup)}` : `setting up · ${setup.command} · ${age}`);

export const TONE_CLASS: Readonly<Record<WorkerTone, string>> = {
  "needs-you": "text-needs-you-text",
  accepted: "text-accepted-text",
  failed: "text-failed-text",
  subtle: "text-text-subtle",
};

/** A waiting worker's hover: "Waiting on a command · bench.sh · 4m" (ENG-742). */
export const waitingHover = (waiting: PhaseWaiting, age: string) => {
  const words = waitingWords(waiting);
  const { text } = waitingDetail(waiting);

  return [
    `${words.charAt(0).toUpperCase()}${words.slice(1)}`,
    ...(waiting.tasks.length > 0 ? [text] : []),
    age,
  ].join(" · ");
};

/** A blocked worker's hover: "blocked by F1b · reason", or "waiting on the lead · reason". */
export const blockedHover = (attempt: {
  readonly blockedOn: ReadonlyArray<string>;
  readonly blockedReason?: string | null;
}) =>
  [
    attempt.blockedOn.length === 0
      ? "waiting on the lead"
      : `blocked by ${attempt.blockedOn.join(", ")}`,
    attempt.blockedReason ?? null,
  ]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
