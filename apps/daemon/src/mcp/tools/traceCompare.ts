/** `trace_compare`'s input, its two sides resolved against now, and its text and JSON view. */
import { TraceError } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { AttributeFilters } from "../../traces/attributes.ts";
import {
  CHANGE_THRESHOLD,
  type SpanCompare,
  type SpanCompareSide,
  type SpanGroupChange,
} from "../../traces/spanCompare.ts";
import { STATS_SCAN_CAP } from "../../traces/stats.ts";
import { clipped, duration, inline, TRACE_CAP } from "./traceFormat.ts";

/** A week, the trace store's retention. */
const WEEK_MINUTES = 7 * 24 * 60;

const Minutes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: WEEK_MINUTES }));

export const TraceCompareSideInput = Schema.Struct({
  /** Minutes back from now where the side starts; default 60, or a week with `version`. */
  sinceMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: WEEK_MINUTES }))
  ),
  /** Minutes back from now where it ends; default 0, now. */
  untilMinutes: Schema.optionalKey(Minutes),
  /** Only spans whose resource `service.version` is this build. */
  version: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
});

export type TraceCompareSideInput = typeof TraceCompareSideInput.Type;

export const TraceCompareInput = Schema.Struct({
  a: Schema.optionalKey(TraceCompareSideInput),
  b: Schema.optionalKey(TraceCompareSideInput),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  service: Schema.optionalKey(Schema.String),
  attributes: Schema.optionalKey(AttributeFilters),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  scope: Schema.optionalKey(Schema.Literals(["checkout", "self"])),
});

export type TraceCompareInput = typeof TraceCompareInput.Type;

interface Window {
  readonly sinceMinutes: number;
  readonly untilMinutes: number;
  readonly version?: string;
}

const invalid = (message: string) =>
  new TraceError({
    code: "E-INPUT",
    message,
    fix: "Give each side sinceMinutes greater than untilMinutes, or a version; a defaults to the window just before b only when b has no version.",
  });

const windowOf = (side: TraceCompareSideInput): Window => ({
  sinceMinutes: side.sinceMinutes ?? (side.version === undefined ? 60 : WEEK_MINUTES),
  untilMinutes: side.untilMinutes ?? 0,
  ...(side.version === undefined ? undefined : { version: side.version }),
});

/** B defaults to the last hour; A to the window of B's length just before it. */
const windowsOf = (input: TraceCompareInput): readonly [Window, Window] | TraceError => {
  const b = windowOf(input.b ?? {});

  if (input.a !== undefined) return [windowOf(input.a), b];

  if (b.version !== undefined) return invalid("Comparing a version needs a, the other side.");
  const length = b.sinceMinutes - b.untilMinutes;
  const a = { sinceMinutes: b.sinceMinutes + length, untilMinutes: b.sinceMinutes };

  if (a.sinceMinutes > WEEK_MINUTES)
    return invalid("The window before b reaches past the week of retained spans.");

  return [a, b];
};

const sideOf = (window: Window, now: number): SpanCompareSide => ({
  sinceMs: now - window.sinceMinutes * 60_000,
  ...(window.untilMinutes === 0 ? undefined : { untilMs: now - window.untilMinutes * 60_000 }),
  ...(window.version === undefined ? undefined : { version: window.version }),
});

export interface ResolvedSides {
  readonly a: SpanCompareSide;
  readonly b: SpanCompareSide;
}

/** Both sides as epoch windows, or an `E-INPUT` error when a side is empty or can't default. */
export const resolveSides = (
  input: TraceCompareInput,
  now: number
): Effect.Effect<ResolvedSides, TraceError> => {
  const windows = windowsOf(input);

  if (windows instanceof TraceError) return Effect.fail(windows);
  const empty = windows.find((window) => window.untilMinutes >= window.sinceMinutes);

  if (empty !== undefined)
    return Effect.fail(
      invalid(`A side from ${empty.sinceMinutes} to ${empty.untilMinutes} minutes ago is empty.`)
    );

  return Effect.succeed({ a: sideOf(windows[0], now), b: sideOf(windows[1], now) });
};

const iso = (ms: number) => new Date(ms).toISOString();

const sideLabel = (label: string, side: SpanCompareSide, read: SpanCompare["a"]) =>
  `${label}: ${iso(side.sinceMs)} → ${side.untilMs === undefined ? "now" : iso(side.untilMs)}${side.version === undefined ? "" : ` version ${inline(side.version)}`} · ${read.spans} spans in ${read.groups} groups${read.truncated ? ` (capped at the newest ${STATS_SCAN_CAP}, from ${read.coveredSince})` : ""}`;

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

const metrics = (side: "A" | "B", m: NonNullable<SpanGroupChange["a"]>) =>
  `${side} ×${m.count}  ${m.errors} errors  p95 ${duration(m.p95Ms)}`;

const describe = (change: SpanGroupChange) => {
  if (change.b === null) return change.a === null ? "" : `GONE  ${metrics("A", change.a)}`;

  if (change.a === null) return `APPEARED  ${metrics("B", change.b)}`;

  return `CHANGED  ×${change.a.count} → ×${change.b.count}  errors ${percent(change.a.errorRate)} → ${percent(change.b.errorRate)}  p95 ${duration(change.a.p95Ms)} → ${duration(change.b.p95Ms)}`;
};

const cell = (value: string) => clipped(inline(value), 200, "value", "trace_compare");

const row = (change: SpanGroupChange) =>
  `${cell(change.name)}  ${cell(change.service)}  ${describe(change)}  e.g. trace ${change.example.trace} span ${change.example.span}`;

/** A header per side, the counts, then one line per change trimmed to the shared cap. */
export const compareSidesView = (result: SpanCompare, sides: ResolvedSides) => {
  const rows = result.changes.map(row);
  const total = result.appeared + result.disappeared + result.changed;
  let count = rows.length;

  const title = () =>
    [
      sideLabel("A", sides.a, result.a),
      sideLabel("B", sides.b, result.b),
      `${result.appeared} appeared, ${result.disappeared} disappeared, ${result.changed} changed by ${percent(CHANGE_THRESHOLD)} or more, ${result.unchanged} unchanged${count < total ? ` (${count} shown; add limit or narrow filters)` : ""}`,
    ].join("\n");

  while (count > 0 && [title(), ...rows.slice(0, count)].join("\n").length > TRACE_CAP) count--;

  const side = (spec: SpanCompareSide, read: SpanCompare["a"]) => ({
    since: iso(spec.sinceMs),
    until: spec.untilMs === undefined ? null : iso(spec.untilMs),
    ...(spec.version === undefined ? undefined : { version: spec.version }),
    ...read,
  });

  return {
    text: [title(), ...rows.slice(0, count)].join("\n"),
    data: {
      a: side(sides.a, result.a),
      b: side(sides.b, result.b),
      changes: result.changes.slice(0, count).map((change) => ({
        ...change,
        a: change.a === null ? null : { ...change.a },
        b: change.b === null ? null : { ...change.b },
        example: { ...change.example },
      })),
      appeared: result.appeared,
      disappeared: result.disappeared,
      changed: result.changed,
      unchanged: result.unchanged,
    },
  };
};
