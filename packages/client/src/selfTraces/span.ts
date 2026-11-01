/** Effect Spans as Self-Trace Spans (`SelfSpan`), and the W3C `traceparent` of a Span. */
import type { SelfSpan, TraceAttributes, TraceParent } from "@polaris/protocol";
import { TraceParent as TraceParentSchema } from "@polaris/protocol";
import { Cause, Exit, Option, Predicate, Schema, Tracer } from "effect";

export interface SelfSpanOrigin {
  /** `service.name`, e.g. `polaris-desktop-main`. */
  readonly service: string;
  readonly version: string;
  /** The instrumentation scope, e.g. `@polaris/desktop`. */
  readonly scope: string;
}

const STATUS_MESSAGE_CHARS = 1024;

type Json = TraceAttributes[string];

const isJson = Schema.is(Schema.Json);

/** Effect's attribute values are arbitrary; JSON stays, a bigint becomes digits, the rest a marker. */
const attributesOf = (entries: Iterable<readonly [string, unknown]>): TraceAttributes => {
  const out: Record<string, Json> = {};

  for (const [key, value] of entries) {
    if (isJson(value)) out[key] = value;
    else if (Predicate.isBigInt(value)) out[key] = value.toString();
    else out[key] = "[unserializable]";
  }

  return out;
};

const failureText = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "";
  const error = Cause.squash(exit.cause);
  const text = Predicate.isError(error) ? error.message : String(error);

  return text.slice(0, STATUS_MESSAGE_CHARS);
};

const isFailure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause);

/** The ended Span as `traces.ingestSelf` carries it; null while it is still running. */
export const selfSpanOf = (span: Tracer.Span, origin: SelfSpanOrigin): SelfSpan | null => {
  const status = span.status;

  if (!Predicate.isTagged(status, "Ended")) return null;
  const { startTime, endTime, exit } = status;
  const failed = isFailure(exit);
  const events = span instanceof Tracer.NativeSpan ? span.events : [];

  return {
    traceId: span.traceId,
    id: span.spanId,
    parentId: Option.match(span.parent, { onNone: () => null, onSome: (parent) => parent.spanId }),
    name: span.name,
    kind: span.kind,
    status: failed ? "error" : "unset",
    statusMessage: failed ? failureText(exit) : "",
    traceState: "",
    startTimeUnixNano: startTime.toString(),
    endTimeUnixNano: endTime.toString(),
    attributes: attributesOf(span.attributes),
    resource: { "service.name": origin.service, "service.version": origin.version },
    scope: { name: origin.scope, version: origin.version, attributes: {} },
    events: events.map(([name, time, attributes]) => ({
      name,
      timeUnixNano: time.toString(),
      attributes: attributesOf(Object.entries(attributes)),
      droppedAttributes: 0,
    })),
    links: span.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      traceState: "",
      attributes: attributesOf(Object.entries(link.attributes)),
      droppedAttributes: 0,
    })),
    droppedAttributes: 0,
    droppedEvents: 0,
    droppedLinks: 0,
  };
};

const isTraceParent = Schema.is(TraceParentSchema);

/** `00-<trace id>-<span id>-<flags>`, or null when the ids aren't W3C ids (a no-op Span's). */
export const traceParentOf = (ids: {
  readonly traceId: string | undefined;
  readonly spanId: string | undefined;
  readonly sampled?: boolean | undefined;
}): TraceParent | null => {
  const value = `00-${ids.traceId}-${ids.spanId}-${ids.sampled === false ? "00" : "01"}`;

  return isTraceParent(value) ? value : null;
};

/** The trace and parent Span ids a valid `traceparent` names. */
export const traceParentIds = (traceparent: TraceParent) => ({
  traceId: traceparent.slice(3, 35),
  spanId: traceparent.slice(36, 52),
  sampled: (Number.parseInt(traceparent.slice(53, 55), 16) & 1) === 1,
});
