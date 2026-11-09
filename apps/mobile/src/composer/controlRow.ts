/**
 * The control row's readouts (Paper MX-E): the running Subagents as moons with a count, and
 * the context ring, as the Desktop App's composer reads them (`ComposerStatus.tsx`).
 */
import type { ContextUsage, Subagent } from "@polaris/protocol";
import { CONTROL_TEXT_SCALE } from "../theme/textScale.ts";

/** Moons drawn before the count says the rest. */
export const MOONS_SHOWN = 3;

/** At or past this share the window reads as nearly full. */
export const CONTEXT_NEARLY_FULL = 0.85;

export interface Moons {
  /** Each shown moon's place among the session's Subagents, which picks its body. */
  readonly moons: ReadonlyArray<{ readonly id: string; readonly index: number }>;
  readonly running: number;
}

/** The working Subagents, in the order they started; nothing when none is working. */
export const moonsOf = (subagents: ReadonlyArray<Subagent>): Moons => {
  const working = subagents.flatMap((subagent, index) =>
    subagent.status === "working" ? [{ subagent, index }] : []
  );

  return {
    moons: working.slice(0, MOONS_SHOWN).map(({ subagent, index }) => ({ id: subagent.id, index })),
    running: working.length,
  };
};

export interface ContextRing {
  /** The ring's fill, 0–1; empty while the window is unknown. */
  readonly share: number;
  /** "17%", "84k" while the window is unknown, "—" before any report. */
  readonly words: string;
  readonly nearlyFull: boolean;
}

/** "840", "84k", "1.2M". */
export const formatTokens = (tokens: number): string => {
  if (tokens < 1000) return `${tokens}`;

  // 999,800 rounds up to a thousand thousands: that reads as "1M", never "1000k".
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`;

  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
};

/** An empty ring and "—" until the Harness reports usage, never 0%. */
export const contextRing = (usage: ContextUsage | null): ContextRing => {
  if (usage === null) return { share: 0, words: "—", nearlyFull: false };

  if (usage.windowTokens === null || usage.windowTokens <= 0)
    return { share: 0, words: formatTokens(usage.usedTokens), nearlyFull: false };
  const share = Math.min(1, Math.max(0, usage.usedTokens / usage.windowTokens));

  return { share, words: `${Math.round(share * 100)}%`, nearlyFull: share >= CONTEXT_NEARLY_FULL };
};

/** How many of the ring's segments are lit, as MX-E draws it in twenty. */
export const RING_SEGMENTS = 20;

export const litSegments = (share: number): number =>
  share <= 0 ? 0 : Math.max(1, Math.round(share * RING_SEGMENTS));

/** What the row has to hold besides the chip and Send. */
export interface RowParts {
  readonly running: number;
  readonly attach: boolean;
  readonly mic: boolean;
}

/** What fits: the chip keeps room for a name and Send stays inside the composer. */
export interface RowFit {
  readonly moons: number;
  readonly ring: boolean;
  readonly ringWords: boolean;
  readonly mic: boolean;
}

const GAP = 6;

const BUTTON = 32;

/** Approximate widths at a text scale, from ControlRow's styles. */
const widthOf = (fit: RowFit, parts: RowParts, scale: number): number => {
  const chip = 58 + 48 * scale;
  const send = 34;

  const moons =
    fit.moons === 0 ? 0 : 4 + fit.moons * 16 + 4 + 8 * `${parts.running}`.length * scale;

  const ring = fit.ring ? 18 + (fit.ringWords ? 4 + 30 * scale : 0) : 0;
  const shown = [moons, ring, parts.attach ? BUTTON : 0, fit.mic ? BUTTON : 0];

  return chip + send + shown.reduce((sum, w) => sum + w + (w > 0 ? GAP : 0), GAP);
};

/** Drops the least needed first: the ring's words, all but one moon, the ring, then the mic. */
const DROPS: ReadonlyArray<(fit: RowFit) => RowFit> = [
  (fit) => ({ ...fit, ringWords: false }),
  (fit) => ({ ...fit, moons: Math.min(fit.moons, 1) }),
  (fit) => ({ ...fit, ring: false }),
  (fit) => ({ ...fit, mic: false }),
];

/** The row's readouts that fit `width`; everything while the width isn't measured yet. */
export const fitControlRow = (width: number | null, fontScale: number, parts: RowParts): RowFit => {
  const scale = Math.min(Math.max(fontScale, 1), CONTROL_TEXT_SCALE);

  let fit: RowFit = {
    moons: Math.min(parts.running, MOONS_SHOWN),
    ring: true,
    ringWords: true,
    mic: parts.mic,
  };

  for (const drop of DROPS) {
    if (width === null || widthOf(fit, parts, scale) <= width) return fit;
    fit = drop(fit);
  }

  return fit;
};

/** How long Stop ignores a tap after Send: a double tap must not interrupt what it just sent. */
export const STOP_GRACE_MS = 600;

/** What a tap on Send does: send, stop the Turn, or nothing while Stop has just appeared. */
export const sendPress = ({
  stop,
  now,
  sentAt,
}: {
  readonly stop: boolean;
  readonly now: number;
  /** When Send last sent; null before it has. */
  readonly sentAt: number | null;
}): "send" | "stop" | "ignore" => {
  if (!stop) return "send";

  return sentAt !== null && now - sentAt < STOP_GRACE_MS ? "ignore" : "stop";
};
