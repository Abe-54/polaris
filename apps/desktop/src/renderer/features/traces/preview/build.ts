/**
 * Builds protocol Traces from short specs: span times are milliseconds after the trace's start,
 * and every summary field is derived from the spans, as the Daemon's store would.
 */
import type {
  LogRecord,
  SessionId,
  Span,
  TraceAttributes,
  TraceDetail,
  TraceStatus,
  TraceSummary,
  TraceTurn,
  WorkspaceId,
} from "@polaris/protocol";

export interface SpanSpec {
  readonly id: string;
  readonly parent: string | null;
  readonly name: string;
  readonly service: string;
  readonly kind?: Span["kind"];
  /** Milliseconds after the trace's start. */
  readonly at: number;
  readonly ms: number;
  readonly status?: TraceStatus;
  readonly statusMessage?: string;
  readonly attributes?: TraceAttributes;
  readonly events?: ReadonlyArray<{
    readonly name: string;
    readonly at: number;
    readonly attributes: TraceAttributes;
  }>;
  readonly links?: Span["links"];
}

export interface TraceSpec {
  readonly id: string;
  /** ISO-8601 with milliseconds: the earliest retained span's start. */
  readonly startedAt: string;
  readonly turn: TraceTurn | null;
  /** The Turn that launched the exporting process; the Daemon sends null until ENG-673. */
  readonly launchedTurn: TraceTurn | null;
  readonly spans: ReadonlyArray<SpanSpec>;
  readonly partial?: boolean;
  readonly linked?: boolean;
}

export interface Checkout {
  readonly checkout: string;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
}

/** Exact Unix nanoseconds as a decimal string, `ms` after `iso`. */
export const nanos = (iso: string, ms = 0): string =>
  String(BigInt(Date.parse(iso)) * 1_000_000n + BigInt(Math.round(ms * 1000)) * 1000n);

const SCOPES: Record<Span["kind"], string> = {
  unspecified: "@opentelemetry/api",
  internal: "@opentelemetry/api",
  server: "@opentelemetry/instrumentation-http",
  client: "@opentelemetry/instrumentation-undici",
  producer: "@opentelemetry/api",
  consumer: "@opentelemetry/api",
};

/** A stable process id per service, as an int64 decimal string (TraceAttributes). */
export const fixturePid = (service: string) =>
  String(
    40_000 +
      Array.from(service, (c) => c.charCodeAt(0)).reduce((sum, c) => (sum * 31 + c) % 9_000, 0)
  );

const resource = (service: string): TraceAttributes => ({
  "service.name": service,
  "process.pid": fixturePid(service),
  "telemetry.sdk.language": "nodejs",
  "telemetry.sdk.name": "opentelemetry",
  "telemetry.sdk.version": "2.2.0",
  "process.runtime.name": "nodejs",
  "process.runtime.version": "24.11.0",
});

const span = (trace: TraceSpec, at: Checkout, s: SpanSpec): Span => {
  const kind = s.kind ?? "internal";
  const status = s.status ?? "unset";

  return {
    traceId: trace.id,
    id: s.id,
    parentId: s.parent,
    name: s.name,
    kind,
    service: s.service,
    status,
    statusMessage: s.statusMessage ?? "",
    traceState: "",
    startTimeUnixNano: nanos(trace.startedAt, s.at),
    endTimeUnixNano: nanos(trace.startedAt, s.at + s.ms),
    durationMs: s.ms,
    attributes: s.attributes ?? {},
    resource: resource(s.service),
    scope: { name: SCOPES[kind], version: "0.57.0", attributes: {} },
    polaris: { ...at, turn: trace.turn, launchedTurn: trace.launchedTurn },
    events: (s.events ?? []).map((e) => ({
      name: e.name,
      timeUnixNano: nanos(trace.startedAt, e.at),
      attributes: e.attributes,
      droppedAttributes: 0,
    })),
    links: s.links ?? [],
    droppedAttributes: 0,
    droppedEvents: 0,
    droppedLinks: 0,
  };
};

const byStart = (a: Span, b: Span) => {
  const delta = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano);

  if (delta !== 0n) return delta < 0n ? -1 : 1;

  return a.id < b.id ? -1 : 1;
};

/** The trace's retained spans in start order, and its summary. */
export const buildTrace = (trace: TraceSpec, at: Checkout): TraceDetail => {
  const spans = trace.spans.map((s) => span(trace, at, s)).sort(byStart);
  const first = spans[0];

  if (first === undefined) throw new Error(`trace ${trace.id} has no spans`);
  const root = spans.find((s) => s.parentId === null) ?? first;
  const start = Math.min(...trace.spans.map((s) => s.at));
  const end = Math.max(...trace.spans.map((s) => s.at + s.ms));
  const errors = spans.filter((s) => s.status === "error").length;

  const summary: TraceSummary = {
    id: trace.id,
    root: root.name,
    rootSpanId: root.id,
    service: root.service,
    startedAt: trace.startedAt,
    startTimeUnixNano: first.startTimeUnixNano,
    durationMs: end - start,
    spans: spans.length,
    services: [...new Set(spans.map((s) => s.service))].sort(),
    errors,
    status: errors > 0 ? "error" : root.status,
    turn: trace.turn,
    sessionId: at.sessionId,
    linked: trace.linked ?? false,
    partial: trace.partial ?? false,
  };

  return { summary, spans };
};

export interface LogSpec {
  readonly id: string;
  readonly trace: TraceSpec;
  readonly spanId: string | null;
  readonly at: number;
  readonly severity: "INFO" | "WARN" | "ERROR";
  readonly body: string;
  readonly service: string;
  readonly attributes?: TraceAttributes;
}

const SEVERITY = { INFO: 9, WARN: 13, ERROR: 17 } as const;

export const buildLog = (log: LogSpec, at: Checkout): LogRecord => ({
  id: log.id,
  traceId: log.spanId === null ? null : log.trace.id,
  spanId: log.spanId,
  timeUnixNano: nanos(log.trace.startedAt, log.at),
  observedTimeUnixNano: nanos(log.trace.startedAt, log.at + 1),
  severityNumber: SEVERITY[log.severity],
  severityText: log.severity,
  body: log.body,
  attributes: log.attributes ?? {},
  resource: resource(log.service),
  scope: { name: "pino", version: "9.6.0", attributes: {} },
  polaris: { ...at, turn: log.trace.turn, launchedTurn: log.trace.launchedTurn },
  droppedAttributes: 0,
});
