/** `trace_capture`'s view: the window's Spans grouped by trace, each a tree in start order. */
import type { Schema } from "effect";
import { CAPTURE_SPAN_CAP, type CapturedSpan, type SpanCapture } from "../../traces/capture.ts";
import { clipped, duration, inline, TRACE_CAP } from "./traceFormat.ts";

/** The Desktop App's user-action roots (ADR 0095). */
export const ACTION_PREFIX = "polaris.action.";

export interface CaptureWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly scope: "self" | "checkout";
  readonly until: string | null;
  readonly matched: boolean | null;
}

interface Placed {
  readonly span: CapturedSpan;
  readonly depth: number;
  /** A root only because its parent wasn't captured (it started earlier, or never arrived). */
  readonly orphan: boolean;
}

interface Group {
  readonly id: string;
  readonly placed: ReadonlyArray<Placed>;
  readonly start: bigint;
  readonly end: bigint;
}

const cell = (value: string) => clipped(inline(value), 200, "value", "trace_capture");

// Zero-padded nanoseconds, so text order is time order.
const byStart = (a: CapturedSpan, b: CapturedSpan) => a.start.localeCompare(b.start);

const endOf = (span: CapturedSpan) => BigInt(span.start) + BigInt(Math.round(span.duration * 1e6));

const ms = (nanos: bigint) => Number(nanos) / 1e6;

/** Depth first, children in start order; a Span whose parent wasn't captured is a root. */
const place = (spans: ReadonlyArray<CapturedSpan>): ReadonlyArray<Placed> => {
  const ids = new Set(spans.map((span) => span.span));
  const children = new Map<string, Array<CapturedSpan>>();
  const roots: Array<CapturedSpan> = [];

  for (const span of spans.toSorted(byStart)) {
    const parent = span.parent;

    if (parent === null || parent === span.span || !ids.has(parent)) {
      roots.push(span);
      continue;
    }

    children.set(parent, [...(children.get(parent) ?? []), span]);
  }

  const placed: Array<Placed> = [];

  const visit = (span: CapturedSpan, depth: number) => {
    placed.push({ span, depth, orphan: depth === 0 && span.parent !== null });

    for (const child of children.get(span.span) ?? []) visit(child, depth + 1);
  };

  for (const root of roots) visit(root, 0);

  return placed;
};

const groups = (spans: ReadonlyArray<CapturedSpan>): ReadonlyArray<Group> => {
  const byTrace = Map.groupBy(spans, (span) => span.trace);

  return [...byTrace.entries()]
    .map(([id, members]) => {
      const placed = place(members);
      const starts = members.map((span) => BigInt(span.start));
      const ends = members.map(endOf);

      return {
        id,
        placed,
        start: starts.reduce((a, b) => (b < a ? b : a)),
        end: ends.reduce((a, b) => (b > a ? b : a)),
      };
    })
    .toSorted((a, b) => Number(a.start - b.start));
};

const errorsOf = (group: Group) => group.placed.filter((p) => p.span.error > 0).length;

const header = (group: Group) => {
  const root = group.placed[0]!.span;
  const services = new Set(group.placed.map((p) => p.span.service)).size;
  const errors = errorsOf(group);

  return [
    `trace ${group.id}`,
    cell(root.name),
    cell(root.service),
    `${group.placed.length} spans`,
    `${services} services`,
    duration(ms(group.end - group.start)),
    ...(errors > 0 ? [`${errors} ERROR${errors === 1 ? "" : "S"}`] : []),
    ...(root.name.startsWith(ACTION_PREFIX) ? ["ACTION"] : []),
  ].join("  ");
};

const line = (group: Group, { span, depth, orphan }: Placed) =>
  [
    `${"  ".repeat(depth + 1)}+${duration(ms(BigInt(span.start) - group.start))}`,
    cell(span.name),
    cell(span.service),
    duration(span.duration),
    ...(span.error > 0 ? ["ERROR"] : []),
    `span ${span.span}`,
    ...(orphan ? [`(parent ${span.parent} not captured)`] : []),
  ].join("  ");

const spanData = (group: Group, { span, depth }: Placed) => ({
  id: span.span,
  parent: span.parent,
  depth,
  name: span.name,
  service: span.service,
  offsetMs: ms(BigInt(span.start) - group.start),
  durationMs: span.duration,
  error: span.error > 0,
});

const traceData = (group: Group, shown: ReadonlyArray<Placed>) => {
  const root = group.placed[0]!.span;

  return {
    id: group.id,
    root: root.name,
    service: root.service,
    action: root.name.startsWith(ACTION_PREFIX),
    startedAt: new Date(ms(group.start)).toISOString(),
    durationMs: ms(group.end - group.start),
    spanCount: group.placed.length,
    errors: errorsOf(group),
    spans: shown.map((placed) => spanData(group, placed)),
  };
};

const windowText = (window: CaptureWindow) => {
  const seconds = Number(((window.endMs - window.startMs) / 1_000).toFixed(1));

  const until =
    window.until === null
      ? ""
      : `, until "${cell(window.until)}" ${window.matched === true ? "matched" : "didn't match"}`;

  return `${new Date(window.startMs).toISOString()} for ${seconds}s${until}`;
};

const windowData = (window: CaptureWindow) => ({
  start: new Date(window.startMs).toISOString(),
  end: new Date(window.endMs).toISOString(),
  scope: window.scope,
  ...(window.until === null
    ? undefined
    : { until: window.until, matched: window.matched === true }),
});

/** A header per trace and a line per Span, trimmed from the end to fit the shared cap. */
export const captureView = (capture: SpanCapture, window: CaptureWindow) => {
  const scope = `Capture (${window.scope}) from ${windowText(window)}`;

  if (capture.spans.length === 0)
    return {
      text: `${scope} · no spans started in the window. Start the capture, then do the action; Polaris's own spans need scope self and Developer Mode.`,
      data: { window: windowData(window), spans: 0, traceCount: 0, truncated: false, traces: [] },
    } satisfies { text: string; data: Schema.JsonObject };

  const all = groups(capture.spans);

  const rows = all.flatMap((group, index) => [
    { index, placed: null, text: header(group) },
    ...group.placed.map((placed) => ({ index, placed, text: line(group, placed) })),
  ]);

  let count = rows.length;

  const capped = capture.truncated
    ? ` (the first ${CAPTURE_SPAN_CAP}; shorten seconds or use until for the rest)`
    : "";

  const title = () =>
    `${scope} · ${capture.spans.length} spans in ${all.length} traces${capped}${count < rows.length ? ` · ${rows.length - count} lines folded; shorten seconds or use until` : ""}`;

  while (
    count > 0 &&
    [title(), ...rows.slice(0, count).map((r) => r.text)].join("\n").length > TRACE_CAP
  )
    count--;

  const shown = rows.slice(0, count);

  const traces = all.flatMap((group, index) => {
    const placed = shown
      .filter((r) => r.index === index)
      .flatMap((r) => (r.placed === null ? [] : [r.placed]));

    return shown.some((r) => r.index === index) ? [traceData(group, placed)] : [];
  });

  return {
    text: [title(), ...shown.map((r) => r.text)].join("\n"),
    data: {
      window: windowData(window),
      spans: capture.spans.length,
      traceCount: all.length,
      truncated: capture.truncated,
      traces,
    },
  } satisfies { text: string; data: Schema.JsonObject };
};
