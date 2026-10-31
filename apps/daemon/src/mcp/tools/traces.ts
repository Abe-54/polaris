import {
  SpanIdPrefix,
  TraceIdPrefix,
  type SessionId,
  type TraceError,
  type TraceFilter,
  type TraceSummary,
} from "@polaris/protocol";
import { Effect, Match, Option, Schema } from "effect";
import type { SessionTools } from "../sessions/index.ts";
import { jsonSchema, type BoundTool, type McpToolResult } from "./shared.ts";
import { duration, inline, clipped, TRACE_CAP } from "./traceFormat.ts";
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
  readonly view: (
    checkout: string,
    id: string,
    focus: "slow" | "errors" | "all"
  ) => Effect.Effect<import("../../traces/workerProtocol.ts").TraceView, TraceError>;
  readonly span: (
    sessionId: SessionId,
    checkout: string,
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
    ...(page.errors[trace.id] === undefined ? undefined : { errorMessage: page.errors[trace.id]! }),
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

          return viewResult(yield* traces.view(context.checkout, input.id, input.focus ?? "slow"));
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

          return viewResult(spanView(result.detail, result.start, result.dataSource));
        })
    ),
  ];
};
