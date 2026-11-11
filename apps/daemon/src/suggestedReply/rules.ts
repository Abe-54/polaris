/** When the Daemon writes a fallback Suggested Reply (ADR 0106), and with which Harness. */
import {
  AUTO_SUGGESTED_REPLY_FALLBACKS,
  type HarnessKind,
  type HostHarnesses,
  type PlanLimit,
  type SuggestedReplyFallback,
  type SuggestedReplySettings,
  type Turn,
} from "@polaris/protocol";
import { lastTurn, type SessionRecord } from "../store/model.ts";

/**
 * Harnesses that write their own Suggested Replies; the fallback never runs for them. Empty:
 * Claude Code sends none through the SDK yet, so it gets the fallback too (ENG-891).
 */
export const NATIVE_SUGGESTIONS: ReadonlySet<HarnessKind> = new Set<HarnessKind>();

/** The Harnesses an inline runner can drive. */
export type InlineHarness = "claude" | "codex";

export const isInlineHarness = (harness: HarnessKind): harness is InlineHarness =>
  harness === "claude" || harness === "codex";

/**
 * A window of the Harness that has reached its limit. Not `warning`, which Claude also sends
 * for a fast pace at low use; and a suggestion is one small request.
 */
export const atPlanLimit = (harness: HarnessKind, limits: ReadonlyArray<PlanLimit>) =>
  limits.some((limit) => limit.harness === harness && limit.status === "reached");

/**
 * The ended Turn this session is due a fallback suggestion for, or null: the user's own
 * session, on a Harness without its own, after a completed Turn (the first too), out of plan mode.
 */
export const suggestionDue = (record: SessionRecord | undefined): Turn | null => {
  const turn = record && lastTurn(record);

  if (record === undefined || turn === undefined) return null;
  const { session } = record;

  if (
    NATIVE_SUGGESTIONS.has(session.harness) ||
    session.origin != null ||
    session.permissionMode === "plan" ||
    session.state === "limited" ||
    turn.status !== "completed" ||
    turn.idleCompaction === true ||
    turn.shellCommand != null
  )
    return null;

  return turn;
};

/** A fallback an inline runner drives. */
export interface RunnableFallback {
  readonly harness: InlineHarness;
  readonly model: SuggestedReplyFallback["model"];
  readonly effort: SuggestedReplyFallback["effort"];
}

const ready = (report: HostHarnesses, harness: HarnessKind) =>
  report.harnesses.some((entry) => entry.harness === harness && entry.status === "ready");

/**
 * The fallbacks to try now, in order: the Settings choice, then each automatic pick. Kept only
 * when an inline runner can drive it and its Harness is ready; a model is never asked twice.
 */
export const fallbackCandidates = (
  settings: SuggestedReplySettings,
  report: HostHarnesses
): ReadonlyArray<RunnableFallback> => {
  const picks = settings.fallback === null ? [] : [settings.fallback];
  const found: Array<RunnableFallback> = [];

  for (const { harness, model, effort } of [...picks, ...AUTO_SUGGESTED_REPLY_FALLBACKS]) {
    const runnable = isInlineHarness(harness) && ready(report, harness);
    const seen = found.some((f) => f.harness === harness && f.model === model);

    if (runnable && !seen) found.push({ harness, model, effort });
  }

  return found;
};
