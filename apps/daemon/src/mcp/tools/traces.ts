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
import { Effect, Match, Option, Schema } from "effect";
import type { SessionTools } from "../sessions/index.ts";
import { jsonSchema, type BoundTool, type McpToolResult } from "./shared.ts";
import { duration, inline, TRACE_CAP, traceView } from "./traceFormat.ts";
import { compareView } from "./compareFormat.ts";
import { spanView } from "./spanFormat.ts";

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
});

export type TracesInput = typeof TracesInput.Type;

export interface TraceToolContext {
  readonly checkout: string;
  readonly endpoint: string | null;
  readonly filter: TraceFilter;
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
    },
    TraceError
  >;
  readonly get: (
    checkout: string,
    id: string
  ) => Effect.Effect<import("@polaris/protocol").TraceDetail, TraceError>;
  readonly history: (
    checkout: string,
    id: string
  ) => Effect.Effect<import("../../traces/workerProtocol.ts").TraceHistory, TraceError>;
  readonly span: (
    sessionId: SessionId,
    checkout: string,
    trace: string,
    span: string
  ) => Effect.Effect<
    { detail: import("@polaris/protocol").SpanDetail; dataSource?: { id: string; name: string } },
    TraceError
  >;
}

const failure = (code: string, message: string, fix: string): McpToolResult => ({
  isError: true,
  content: [{ type: "text", text: `${code}: ${message}\nFix: ${fix}`.slice(0, TRACE_CAP) }],
  structuredContent: { code, message, fix },
});

const viewResult = (view: {
  text: string;
  data: NonNullable<McpToolResult["structuredContent"]>;
}): McpToolResult => ({
  content: [{ type: "text", text: view.text }],
  structuredContent: view.data,
});

const listView = (
  page: {
    traces: ReadonlyArray<TraceSummary>;
    total: number;
    history: Record<string, number>;
    errors: Record<string, string>;
  },
  turn: TraceToolContext["turn"]
) => {
  const rows = page.traces.map(
    (trace) =>
      `${trace.id.slice(0, 8)}  ${inline(trace.root)}  ${inline(trace.service)}  ${duration(trace.durationMs)}  ${trace.spans} spans  ${trace.services.length} services${page.history[trace.id] === undefined ? "" : `  SLOW (usually ${duration(page.history[trace.id]!)})`}${trace.errors ? `  ${trace.errors} ERROR${page.errors[trace.id] ? `: ${inline(page.errors[trace.id]!)}` : ""}` : ""}`
  );

  const label = Match.value(turn).pipe(
    Match.when("all", () => "All turns"),
    Match.when(null, () => "Between turns"),
    Match.orElse((number) => `Turn ${number}`)
  );

  let count = rows.length;

  const title = () =>
    `${label} · ${page.total} traces${count < page.total ? ` (${count} shown of ${page.total}; add limit or narrow filters)` : ""}`;

  while (count > 0 && [title(), ...rows.slice(0, count)].join("\n").length > TRACE_CAP) count--;

  const traces = page.traces.slice(0, count).map((trace) => ({
    id: trace.id,
    root: trace.root,
    service: trace.service,
    durationMs: trace.durationMs,
    spans: trace.spans,
    services: trace.services,
    errors: trace.errors,
    turn: trace.turn,
    startedAt: trace.startedAt,
    ...(page.history[trace.id] === undefined
      ? undefined
      : { slow: { usualMs: page.history[trace.id]! } }),
  }));

  return { text: [title(), ...rows.slice(0, count)].join("\n"), data: { traces } };
};

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
              "Use the fields in this tool's input schema."
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
      "List this checkout's traces, newest first. Defaults to the current turn; turn all includes every turn. Filter by root route glob, service, status or minMs; limit defaults to 20, at most 50.",
      TracesInput,
      (input, traces) =>
        Effect.gen(function* () {
          const context = yield* traces.context(sessionId, input);

          return viewResult(listView(yield* traces.list(context), context.turn));
        })
    ),
    make(
      "trace",
      "Summarise a trace as a tree with errors, critical path and repeated siblings collapsed. Use a full or unique prefix id (at least 8 hex). Focus slow (default), errors or all.",
      Schema.Struct({
        id: TraceIdPrefix,
        focus: Schema.optionalKey(Schema.Literals(["slow", "errors", "all"])),
      }),
      (input, traces) =>
        Effect.gen(function* () {
          const context = yield* traces.context(sessionId, { turn: "all" });
          const detail = yield* traces.get(context.checkout, input.id);

          return viewResult(
            traceView(
              detail,
              input.focus ?? "slow",
              yield* traces.history(context.checkout, detail.summary.id)
            )
          );
        })
    ),
    make(
      "span",
      "Read one full span, grouped attributes, events, exception stack, newest 20 logs, links and code location. Database spans name a matching data source. Both ids take unique prefixes of at least 8 hex.",
      Schema.Struct({ trace: TraceIdPrefix, span: SpanIdPrefix }),
      (input, traces) =>
        Effect.gen(function* () {
          const context = yield* traces.context(sessionId, { turn: "all" });
          const result = yield* traces.span(sessionId, context.checkout, input.trace, input.span);
          const trace = yield* traces.get(context.checkout, input.trace);

          return viewResult(
            spanView(result.detail, trace.summary.startTimeUnixNano, result.dataSource)
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
