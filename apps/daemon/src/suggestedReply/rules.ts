/** When the Daemon writes a fallback Suggested Reply (ADR 0106), and with which Harness. */
import {
  AUTO_SUGGESTED_REPLY_FALLBACKS,
  type HarnessKind,
  type HostHarnesses,
  type PlanLimit,
  ResolvedSuggestedReplyFallback,
  type SuggestedReplyFallback,
  type SuggestedReplySettings,
  type Turn,
} from "@polaris/protocol";
import { lastTurn, type SessionRecord } from "../store/model.ts";

/** Harnesses that write their own Suggested Replies; the fallback never runs for them. */
export const NATIVE_SUGGESTIONS: ReadonlySet<HarnessKind> = new Set(["claude"]);

/** The Harnesses an inline runner can drive. */
export type InlineHarness = "claude" | "codex";

export const isInlineHarness = (harness: HarnessKind): harness is InlineHarness =>
  harness === "claude" || harness === "codex";

/** A window of the Harness at or near its limit (the Harness reports `warning` near it). */
export const nearPlanLimit = (harness: HarnessKind, limits: ReadonlyArray<PlanLimit>) =>
  limits.some((limit) => limit.harness === harness && limit.status !== "ok");

const isFirstTurn = (turn: Turn) => (turn.userTurnNumber ?? turn.index + 1) <= 1;

/**
 * The ended Turn this session is due a fallback suggestion for, or null: the user's own
 * session, on a Harness without its own, after a completed Turn past the first, out of plan mode.
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
    turn.shellCommand != null ||
    isFirstTurn(turn)
  )
    return null;

  return turn;
};

const ready = (report: HostHarnesses, harness: HarnessKind) =>
  report.harnesses.some((entry) => entry.harness === harness && entry.status === "ready");

const runnable = (report: HostHarnesses, choice: SuggestedReplyFallback) =>
  isInlineHarness(choice.harness) && ready(report, choice.harness);

/** The Settings choice when its Harness is ready, else (when unset) the first ready automatic one. */
export const resolveFallback = (
  settings: SuggestedReplySettings,
  report: HostHarnesses
): ResolvedSuggestedReplyFallback => {
  if (settings.fallback !== null)
    return ResolvedSuggestedReplyFallback.make({
      choice: runnable(report, settings.fallback) ? settings.fallback : null,
      source: "settings",
    });

  return ResolvedSuggestedReplyFallback.make({
    choice: AUTO_SUGGESTED_REPLY_FALLBACKS.find((choice) => runnable(report, choice)) ?? null,
    source: "auto",
  });
};
