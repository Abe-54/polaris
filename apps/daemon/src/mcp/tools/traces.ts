import {
  SpanIdPrefix,
  TraceCompareSelector,
  type TraceComparison,
  TraceIdPrefix,
  type SessionId,
  type TraceError,
  type TraceFilter,
  type TraceSummary,
} from "@polaris/protocol";
import { Clock, Effect, Match, Option, Schema } from "effect";
import type { SessionTools } from "../sessions/index.ts";
import { jsonSchema, type BoundTool, type McpToolResult } from "./shared.ts";
import { duration, inline, clipped, TRACE_CAP } from "./traceFormat.ts";
import { compareView } from "./compareFormat.ts";
import { spanView } from "./spanFormat.ts";
import { statsView } from "./statsFormat.ts";
import { captureView } from "./captureFormat.ts";
import { errorsView } from "./errorsFormat.ts";
import type { ReadScopes } from "../../traces/self/reads.ts";
import type { SpanStats, SpanStatsFilter } from "../../traces/stats.ts";
import type { CaptureOptions, CaptureResult } from "../sessions/capture.ts";
import { CAPTURE_SPAN_CAP } from "../../traces/capture.ts";
import type { SpanErrors, SpanErrorsFilter } from "../../traces/errors.ts";
import { AttributeFilters, AttributeKey, TRACES_ATTRIBUTE_SCAN } from "../../traces/attributes.ts";

/** A week, the trace store's retention: the widest `trace_stats` window. */
const MAX_STATS_MINUTES = 7 * 24 * 60;

/** `self` reads Polaris's own Self-Traces; allowed only while Developer Mode is on. */
const TraceScopeInput = Schema.Literals(["checkout", "self"]);

export const TracesInput = Schema.Struct({
  turn: Schema.optionalKey(
    Schema.Union([
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      Schema.Literals(["current", "all"]),
    ])
  ),
  route: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  service: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["error", "ok"])),
  minMs: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  attributes: Schema.optionalKey(AttributeFilters),
  scope: Schema.optionalKey(TraceScopeInput),
});

export type TracesInput = typeof TracesInput.Type;

export const TraceStatsInput = Schema.Struct({
  sinceMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STATS_MINUTES }))
  ),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  service: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["error", "ok"])),
  attributes: Schema.optionalKey(AttributeFilters),
  byAttribute: Schema.optionalKey(AttributeKey),
  by: Schema.optionalKey(Schema.Literals(["name", "service", "both"])),
  sort: Schema.optionalKey(Schema.Literals(["count", "errors", "slow"])),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  scope: Schema.optionalKey(TraceScopeInput),
});

export type TraceStatsInput = typeof TraceStatsInput.Type;

/** The longest `trace_capture` window; Codex stops a tool call at 60 s, so stay under 50 there. */
export const CAPTURE_LIMIT_SECONDS = 300;

const DEFAULT_CAPTURE_SECONDS = 30;

export const TraceCaptureInput = Schema.Struct({
  seconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CAPTURE_LIMIT_SECONDS }))
  ),
  until: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  scope: Schema.optionalKey(TraceScopeInput),
});

export type TraceCaptureInput = typeof TraceCaptureInput.Type;

export const TraceErrorsInput = Schema.Struct({
  sinceMinutes: TraceStatsInput.fields.sinceMinutes,
  name: TraceStatsInput.fields.name,
  service: TraceStatsInput.fields.service,
  limit: TraceStatsInput.fields.limit,
  scope: Schema.optionalKey(TraceScopeInput),
});

export type TraceErrorsInput = typeof TraceErrorsInput.Type;

export interface TraceToolContext {
  readonly checkout: string;
  /** Where `trace` and `span` look, first to last; the Self-Trace scope follows while readable. */
  readonly scopes: ReadScopes;
  readonly endpoint: string | null;
  readonly filter: TraceFilter;
  /** Span attribute equalities for `traces`; they read only the newest Spans. */
  readonly attributes?: AttributeFilters;
  readonly turn: number | "all" | null;
}

export interface TraceSessionTools {
  readonly compare: (
    sessionId: SessionId,
    a: TraceCompareSelector,
    b: TraceCompareSelector
  ) => Effect.Effect<TraceComparison, TraceError>;
  readonly context: (
    sessionId: SessionId,
    input: TracesInput
  ) => Effect.Effect<TraceToolContext, TraceError>;
  readonly list: (context: TraceToolContext) => Effect.Effect<
    {
      traces: ReadonlyArray<TraceSummary>;
      total: number;
      history: Record<string, number>;
      errors: Record<string, string>;
      coveredSince?: string;
    },
    TraceError
  >;
  readonly view: (
    context: TraceToolContext,
    id: string,
    focus: "slow" | "errors" | "all"
  ) => Effect.Effect<import("../../traces/workerProtocol.ts").TraceView, TraceError>;
  readonly stats: (
    context: TraceToolContext,
    filter: SpanStatsFilter
  ) => Effect.Effect<SpanStats, TraceError>;
  /** Blocks for the window (or until a matching Span ends), then reads what started in it. */
  readonly capture: (
    context: TraceToolContext,
    options: CaptureOptions
  ) => Effect.Effect<CaptureResult, TraceError>;
  readonly errors: (
    context: TraceToolContext,
    filter: SpanErrorsFilter
  ) => Effect.Effect<SpanErrors, TraceError>;
  readonly span: (
    sessionId: SessionId,
    context: TraceToolContext,
    trace: string,
    span: string
  ) => Effect.Effect<
    {
      detail: import("@polaris/protocol").SpanDetail;
      start: string;
      dataSource?: { id: string; name: string };
    },
    TraceError
  >;
}

const failure = (code: string, message: string, fix: string): McpToolResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text: `${code}: ${inline(message)}\nFix: ${inline(fix)}`.slice(0, TRACE_CAP).toWellFormed(),
    },
  ],
  structuredContent: { code, message: safeString(message), fix: safeString(fix) },
});

const safeString = (value: string) =>
  value.toWellFormed().replace(/[\u202a-\u202e\u2066-\u2069]/gu, " ");

const safeJson = (value: Schema.Json): Schema.Json => {
  if (Schema.is(Schema.String)(value)) return safeString(value);

  if (value === null || Schema.is(Schema.Number)(value) || Schema.is(Schema.Boolean)(value))
    return value;

  if (Array.isArray(value)) return value.map(safeJson);

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [safeString(key), safeJson(item)])
  );
};

const viewResult = (view: { text: string; data: Schema.JsonObject }): McpToolResult => ({
  content: [{ type: "text", text: view.text }],
  structuredContent: Object.fromEntries(
    Object.entries(view.data).map(([key, value]) => [safeString(key), safeJson(value)])
  ),
});

const listView = (
  page: {
    traces: ReadonlyArray<TraceSummary>;
    total: number;
    history: Record<string, number>;
    errors: Record<string, string>;
    coveredSince?: string;
  },
  turn: TraceToolContext["turn"]
) => {
  const cell = (value: string) => clipped(inline(value), 200, "value", "traces");

  const rows = page.traces.map(
    (trace) =>
      `${trace.id}  ${cell(trace.root)}  ${cell(trace.service)}  ${duration(trace.durationMs)}  ${trace.spans} spans  ${trace.services.length} services${page.history[trace.id] === undefined ? "" : `  SLOW (usually ${duration(page.history[trace.id]!)})`}${trace.errors ? `  ${trace.errors} ERROR${page.errors[trace.id] ? `: ${cell(page.errors[trace.id]!)}` : ""}` : ""}`
  );

  const label = Match.value(turn).pipe(
    Match.when("all", () => "All turns"),
    Match.when(null, () => "Between turns"),
    Match.orElse((number) => `Turn ${number}`)
  );

  const scanned =
    page.coveredSince === undefined
      ? ""
      : `\nAttribute filters read only the newest ${TRACES_ATTRIBUTE_SCAN} spans, from ${page.coveredSince}.`;

  let count = rows.length;

  const title = () =>
    `${label} · ${page.total} traces${count < page.total ? ` (${count} shown of ${page.total}; add limit or narrow filters)` : ""}${scanned}`;

  while (count > 0 && [title(), ...rows.slice(0, count)].join("\n").length > TRACE_CAP) count--;

  const traces = page.traces.slice(0, count).map((trace) => ({
    id: trace.id,
    root: trace.root,
    service: trace.service,
    durationMs: trace.durationMs,
    spans: trace.spans,
    services: trace.services,
    errors: trace.errors,
    ...(page.errors[trace.id] === undefined ? undefined : { errorMessage: page.errors[trace.id]! }),
    turn: trace.turn,
    startedAt: trace.startedAt,
    ...(page.history[trace.id] === undefined
      ? undefined
      : { slow: { usualMs: page.history[trace.id]! } }),
  }));

  return {
    text: [title(), ...rows.slice(0, count)].join("\n"),
    data: {
      traces,
      ...(page.coveredSince === undefined ? undefined : { coveredSince: page.coveredSince }),
    },
  };
};

/** The window's start for a `sinceMinutes` input, default an hour. */
const windowOf = Effect.fnUntraced(function* (sinceMinutes: number | undefined) {
  const minutes = sinceMinutes ?? 60;
  const sinceMs = (yield* Clock.currentTimeMillis) - minutes * 60_000;

  return { minutes, sinceMs, since: new Date(sinceMs).toISOString() };
});

const scoped = (scope: "checkout" | "self" | undefined): TracesInput =>
  scope === undefined ? { turn: "all" } : { turn: "all", scope };

export const traceTools = (sessionId: SessionId, sessions: SessionTools): BoundTool[] => {
  const make = <S extends Schema.Decoder<unknown>>(
    name: string,
    description: string,
    schema: S,
    run: (input: S["Type"], traces: TraceSessionTools) => Effect.Effect<McpToolResult, TraceError>
  ): BoundTool => ({
    name,
    description,
    inputSchema: jsonSchema(schema),
    annotations: { readOnlyHint: true },
    call: (input, signal) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const decoded = Schema.decodeUnknownOption(schema)(input, { onExcessProperty: "error" });

          if (Option.isNone(decoded))
            return failure(
              "E-INPUT",
              `Invalid input for ${name}`,
              "Use the fields in this tool's input schema. Trace ids are 8–32 lowercase hex characters; span ids are 8–16 lowercase hex characters."
            );

          if (sessions.traces === undefined)
            return failure(
              "E-TRACE-UNAVAILABLE",
              "Traces isn't connected on this host.",
              "The user can check Traces (⌘5) and Set up tracing."
            );

          return yield* run(decoded.value, sessions.traces);
        }).pipe(
          Effect.catchTag("TraceError", (error) =>
            Effect.succeed(failure(error.code, error.message, error.fix))
          )
        ),
        { signal }
      ),
  });

  return [
    make(
      "traces",
      "List this checkout's traces, newest first. Defaults to the current turn; turn all includes every turn. Filter by root route glob, service, status, minMs or attributes (up to 5 {key, value} equalities; a trace matches when one of its spans among the newest 20,000 has them all); limit defaults to 20, at most 50. scope self lists Polaris's own traces (Daemon and apps) while Developer Mode is on.",
      TracesInput,
      (input, traces) =>
        Effect.gen(function* () {
          const context = yield* traces.context(sessionId, input);

          return viewResult(listView(yield* traces.list(context), context.turn));
        })
    ),
    make(
      "trace",
      "Summarise a trace as a tree with errors, critical path and repeated siblings collapsed. Use a full or unique prefix id (at least 8 hex). Focus slow (default), errors or all. Finds Polaris's own traces too while Developer Mode is on; scope self reads only those.",
      Schema.Struct({
        id: TraceIdPrefix,
        focus: Schema.optionalKey(Schema.Literals(["slow", "errors", "all"])),
        scope: Schema.optionalKey(TraceScopeInput),
      }),
      (input, traces) =>
        Effect.gen(function* () {
          const context = yield* traces.context(sessionId, scoped(input.scope));

          return viewResult(yield* traces.view(context, input.id, input.focus ?? "slow"));
        })
    ),
    make(
      "span",
      "Read one full span, grouped attributes, events, exception stack, newest 20 logs, links and code location. Database spans name a matching data source. Both ids take unique prefixes of at least 8 hex. Finds Polaris's own spans too while Developer Mode is on; scope self reads only those.",
      Schema.Struct({
        trace: TraceIdPrefix,
        span: SpanIdPrefix,
        scope: Schema.optionalKey(TraceScopeInput),
      }),
      (input, traces) =>
        Effect.gen(function* () {
          const context = yield* traces.context(sessionId, scoped(input.scope));
          const result = yield* traces.span(sessionId, context, input.trace, input.span);

          return viewResult(spanView(result.detail, result.start, result.dataSource));
        })
    ),
    make(
      "trace_stats",
      "Count spans by name and/or service over the last sinceMinutes (default 60, at most a week): count, errors, p50/p95/max ms, latest start and an example trace and span (an errored one when there are errors). name matches a case-insensitive substring; filter by service, status or attributes (up to 5 {key, value} equalities on span attributes); by name, service or both (default); byAttribute groups by one attribute's value (alone, unless by is given); sort count (default), errors or slow (p95); limit groups (default 20, at most 100). Reads at most the newest 20,000 matching spans. scope self reads Polaris's own spans while Developer Mode is on.",
      TraceStatsInput,
      (input, traces) =>
        Effect.gen(function* () {
          const context = yield* traces.context(sessionId, scoped(input.scope));
          const window = yield* windowOf(input.sinceMinutes);
          const { sinceMinutes: _since, scope: _scope, byAttribute, ...filters } = input;

          const stats = yield* traces.stats(context, {
            ...filters,
            sinceMs: window.sinceMs,
            by: input.by ?? (byAttribute === undefined ? "both" : "none"),
            ...(byAttribute === undefined ? undefined : { attribute: byAttribute }),
            sort: input.sort ?? "count",
            limit: input.limit ?? 20,
          });

          return viewResult(statsView(stats, { ...window, attribute: byAttribute }));
        })
    ),
    make(
      "trace_errors",
      "Group error spans over the last sinceMinutes (default 60, at most a week) by fingerprint: the message's first line with ids, numbers, quoted text, paths and URLs replaced. Each fingerprint has one raw example message, count, first and last seen, services, its top span names and the newest trace and span. name matches a case-insensitive substring; filter by service; limit fingerprints (default 20, at most 100). Reads at most the newest 20,000 error spans. scope self reads Polaris's own spans while Developer Mode is on.",
      TraceErrorsInput,
      (input, traces) =>
        Effect.gen(function* () {
          const context = yield* traces.context(sessionId, scoped(input.scope));
          const window = yield* windowOf(input.sinceMinutes);
          const { sinceMinutes: _since, scope: _scope, ...filters } = input;

          const errors = yield* traces.errors(context, {
            ...filters,
            sinceMs: window.sinceMs,
            limit: input.limit ?? 20,
          });

          return viewResult(errorsView(errors, window));
        })
    ),
    make(
      "trace_capture",
      `Capture what happens next: block for seconds (default ${DEFAULT_CAPTURE_SECONDS}, at most ${CAPTURE_LIMIT_SECONDS}; under Codex stay below 50), or less with until, a case-insensitive span name substring that returns once a matching span has ended. Then, after a short wait for late batches, returns every span that started in the window across all services, grouped by trace in time order as trees, with span ids for span. In Polaris's own traces a Desktop App user action is a polaris.action.<id> root. At most ${CAPTURE_SPAN_CAP} spans. scope self captures Polaris's own spans while Developer Mode is on.`,
      TraceCaptureInput,
      (input, traces) =>
        Effect.gen(function* () {
          const context = yield* traces.context(sessionId, scoped(input.scope));

          const result = yield* traces.capture(context, {
            seconds: input.seconds ?? DEFAULT_CAPTURE_SECONDS,
            ...(input.until === undefined ? undefined : { until: input.until }),
          });

          return viewResult(
            captureView(result.capture, {
              startMs: result.startMs,
              endMs: result.endMs,
              scope: input.scope ?? "checkout",
              until: input.until ?? null,
              matched: result.matched,
            })
          );
        })
    ),
    make(
      "compare",
      "Compare route p50/p95 timings, counts and slowest new spans. Select two turns (a Turn, or a Turns range from firstTurnId through lastTurnId) or two trace ids; omit a for earlier retained turns against turn b. Fewer than three samples on either side means no baseline.",
      Schema.Struct({ a: Schema.optionalKey(TraceCompareSelector), b: TraceCompareSelector }),
      (input, traces) =>
        Effect.gen(function* () {
          yield* traces.context(sessionId, { turn: "all" });

          return viewResult(
            compareView(
              yield* traces.compare(
                sessionId,
                input.a ?? TraceCompareSelector.cases.Baseline.make({}),
                input.b
              )
            )
          );
        })
    ),
  ];
};
