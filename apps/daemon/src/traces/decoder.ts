/** The single pinned internal OTel import. codec fixtures must pass before changing any decoder pin. */
import root from "@opentelemetry/otlp-transformer/build/src/generated/root.js";
import { Predicate, Schema } from "effect";
import type { Message } from "protobufjs";
import {
  LogRecord,
  Span,
  TraceAttribution,
  type TraceScope,
  type TraceAttributes,
} from "@polaris/protocol";
import { ExportLogs, ExportTraces, type OtlpLog, type OtlpScope, type OtlpSpan } from "./otlp.ts";
import { attributes, attributeValue, redactText } from "./redact.ts";
import {
  IngestError,
  MAX_BATCH_RECORDS,
  MAX_QUEUED_BYTES,
  type IngestContext,
  type TraceBatch,
} from "./ingest.ts";

interface GeneratedCodec {
  decode(bytes: Uint8Array): Message;
  toObject(
    value: Message,
    options: { longs: StringConstructor; bytes: StringConstructor; json: true }
  ): Schema.Json;
}

// SAFETY: 0.213.0's static generated root has these codecs; senders.test.ts and decoder.test.ts exercise the trace and log wire shapes.
const generated = root as typeof root & {
  opentelemetry: {
    proto: {
      collector: {
        trace: { v1: { ExportTraceServiceRequest: GeneratedCodec } };
        logs: { v1: { ExportLogsServiceRequest: GeneratedCodec } };
      };
    };
  };
};

const codecs = {
  traces: generated.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest,
  logs: generated.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest,
};

const decodeTraces = Schema.decodeUnknownSync(ExportTraces);

const decodeLogs = Schema.decodeUnknownSync(ExportLogs);

const decodeSpan = Schema.decodeUnknownSync(Span);

const decodeLog = Schema.decodeUnknownSync(LogRecord);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** Bound nesting before the recursive domain schema; unknown JSON fields still count against this bound. */
const bounded = (value: Schema.Json, depth = 0): void => {
  if (depth > 32) throw new IngestError(400, "OTLP nesting exceeds 32 levels");

  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  )
    return;

  for (const child of Object.values(value)) bounded(child, depth + 1);
};

const id = (value: string, bytes: number, protobuf: boolean): string => {
  const hex = protobuf ? Buffer.from(value, "base64").toString("hex") : value.toLowerCase();

  if (hex.length !== bytes * 2 || !/^[0-9a-f]+$/.test(hex) || /^0+$/.test(hex))
    throw new IngestError(400, "OTLP identifier is invalid");

  return hex;
};

const optionalId = (value: string | undefined, bytes: number, protobuf: boolean) =>
  value === undefined || value === "" ? null : id(value, bytes, protobuf);

const nanos = (value: string | number): string => {
  const n = BigInt(value);

  if (n < 0n || n > 18446744073709551615n)
    throw new IngestError(400, "OTLP timestamp is outside uint64");

  return n.toString();
};

const attribution = (context: IngestContext, start: string): TraceAttribution => {
  const instant = BigInt(start);

  const interval = context.turns.findLast(
    (candidate) =>
      instant >= BigInt(candidate.start) &&
      (candidate.end === null || instant < BigInt(candidate.end))
  );

  return TraceAttribution.make({
    checkout: context.checkout,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    turn: interval?.turn ?? null,
    // A session endpoint cannot establish which Turn launched a child process (ENG-673).
    launchedTurn: null,
  });
};

const scopeOf = (scope?: OtlpScope): typeof TraceScope.Type => ({
  name: redactText(scope?.name ?? ""),
  version: redactText(scope?.version ?? ""),
  attributes: attributes(scope?.attributes),
});

const kinds = ["unspecified", "internal", "server", "client", "producer", "consumer"] as const;

const statuses = ["unset", "ok", "error"] as const;

const spanOf = (
  span: OtlpSpan,
  resource: TraceAttributes,
  scope: typeof TraceScope.Type,
  context: IngestContext,
  protobuf: boolean
): Span => {
  const start = nanos(span.startTimeUnixNano);
  const end = nanos(span.endTimeUnixNano);

  if (BigInt(end) < BigInt(start)) throw new IngestError(400, "OTLP Span ends before it starts");

  return decodeSpan({
    traceId: id(span.traceId, 16, protobuf),
    id: id(span.spanId, 8, protobuf),
    parentId: optionalId(span.parentSpanId, 8, protobuf),
    name: redactText(span.name ?? ""),
    kind: kinds[span.kind ?? 0],
    service: resource["service.name"] ?? "unknown_service",
    status: statuses[span.status?.code ?? 0],
    statusMessage: redactText(span.status?.message ?? ""),
    traceState: redactText(span.traceState ?? ""),
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    durationMs: Number(BigInt(end) - BigInt(start)) / 1e6,
    attributes: attributes(span.attributes),
    resource,
    scope,
    polaris: attribution(context, start),
    events: (span.events ?? []).map((event) => ({
      name: redactText(event.name ?? ""),
      timeUnixNano: nanos(event.timeUnixNano),
      attributes: attributes(event.attributes),
      droppedAttributes: event.droppedAttributesCount ?? 0,
    })),
    links: (span.links ?? []).map((link) => ({
      traceId: id(link.traceId, 16, protobuf),
      spanId: id(link.spanId, 8, protobuf),
      traceState: redactText(link.traceState ?? ""),
      attributes: attributes(link.attributes),
      droppedAttributes: link.droppedAttributesCount ?? 0,
    })),
    droppedAttributes: span.droppedAttributesCount ?? 0,
    droppedEvents: span.droppedEventsCount ?? 0,
    droppedLinks: span.droppedLinksCount ?? 0,
  });
};

const logOf = (
  log: OtlpLog,
  resource: TraceAttributes,
  scope: typeof TraceScope.Type,
  context: IngestContext,
  protobuf: boolean
): LogRecord => {
  const start = nanos(log.timeUnixNano ?? 0);

  return decodeLog({
    id: crypto.randomUUID(),
    traceId: optionalId(log.traceId, 16, protobuf),
    spanId: optionalId(log.spanId, 8, protobuf),
    timeUnixNano: start,
    observedTimeUnixNano: nanos(log.observedTimeUnixNano ?? 0),
    severityNumber: log.severityNumber ?? 0,
    severityText: redactText(log.severityText ?? ""),
    body: attributeValue(log.body),
    attributes: attributes(log.attributes),
    resource,
    scope,
    polaris: attribution(context, start),
    droppedAttributes: log.droppedAttributesCount ?? 0,
  });
};

type Append = <A extends Span | LogRecord>(output: A[], record: A) => void;

const collectSpans = (
  raw: Schema.Json,
  context: IngestContext,
  protobuf: boolean,
  append: Append
) => {
  const spans: Span[] = [];

  for (const r of decodeTraces(raw).resourceSpans ?? []) {
    const resource = attributes(r.resource?.attributes);

    for (const s of r.scopeSpans ?? []) {
      const scope = scopeOf(s.scope);

      for (const span of s.spans ?? [])
        append(spans, spanOf(span, resource, scope, context, protobuf));
    }
  }

  return spans;
};

const collectLogs = (
  raw: Schema.Json,
  context: IngestContext,
  protobuf: boolean,
  append: Append
) => {
  const logs: LogRecord[] = [];

  for (const r of decodeLogs(raw).resourceLogs ?? []) {
    const resource = attributes(r.resource?.attributes);

    for (const s of r.scopeLogs ?? []) {
      const scope = scopeOf(s.scope);

      for (const log of s.logRecords ?? [])
        append(logs, logOf(log, resource, scope, context, protobuf));
    }
  }

  return logs;
};

export const decodeBatch = (
  bytes: Uint8Array,
  signal: "traces" | "logs",
  contentType: string,
  context: IngestContext
): TraceBatch => {
  const protobuf = contentType === "application/x-protobuf";
  const codec = codecs[signal];

  const raw = protobuf
    ? codec.toObject(codec.decode(bytes), { longs: String, bytes: String, json: true })
    : decodeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

  bounded(raw);

  let size = 0;
  let count = 0;

  // Bound the expanded records as they are built: resource attributes repeat in every record.
  const append = <A extends Span | LogRecord>(output: A[], record: A) => {
    size += Buffer.byteLength(JSON.stringify(record));
    count++;

    if (size > MAX_QUEUED_BYTES || count > MAX_BATCH_RECORDS)
      throw new IngestError(413, "Expanded OTLP batch exceeds the record budget");
    output.push(record);
  };

  return signal === "traces"
    ? { spans: collectSpans(raw, context, protobuf, append), logs: [] }
    : { spans: [], logs: collectLogs(raw, context, protobuf, append) };
};
