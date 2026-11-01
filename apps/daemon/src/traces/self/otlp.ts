/** Self-Spans become OTLP JSON so they share the receiver's decoder, redaction and bounds. */
import type { SelfSpan, TraceAttributes } from "@polaris/protocol";
import { Predicate, type Schema } from "effect";
import type { OtlpAttribute, OtlpValue } from "../otlp.ts";

const KINDS = {
  unspecified: 0,
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
} as const;

const STATUSES = { unset: 0, ok: 1, error: 2 } as const;

const isJsonArray = (json: Schema.Json): json is ReadonlyArray<Schema.Json> => Array.isArray(json);

const value = (json: Schema.Json): OtlpValue => {
  if (json === null) return {};

  if (Predicate.isString(json)) return { stringValue: json };

  if (Predicate.isBoolean(json)) return { boolValue: json };

  if (Predicate.isNumber(json))
    return Number.isSafeInteger(json) ? { intValue: json } : { doubleValue: json };

  if (isJsonArray(json)) return { arrayValue: { values: json.map(value) } };

  return { kvlistValue: { values: keyValues(json) } };
};

const keyValues = (attributes: TraceAttributes): OtlpAttribute[] =>
  Object.entries(attributes).map(([key, json]) => ({ key, value: value(json) }));

const spanOf = (span: SelfSpan) => ({
  traceId: span.traceId,
  spanId: span.id,
  // OTLP spells a missing parent as the empty id.
  parentSpanId: span.parentId ?? "",
  traceState: span.traceState,
  name: span.name,
  kind: KINDS[span.kind],
  startTimeUnixNano: span.startTimeUnixNano,
  endTimeUnixNano: span.endTimeUnixNano,
  attributes: keyValues(span.attributes),
  status: { code: STATUSES[span.status], message: span.statusMessage },
  events: span.events.map((event) => ({
    name: event.name,
    timeUnixNano: event.timeUnixNano,
    attributes: keyValues(event.attributes),
    droppedAttributesCount: event.droppedAttributes,
  })),
  links: span.links.map((link) => ({
    traceId: link.traceId,
    spanId: link.spanId,
    traceState: link.traceState,
    attributes: keyValues(link.attributes),
    droppedAttributesCount: link.droppedAttributes,
  })),
  droppedAttributesCount: span.droppedAttributes,
  droppedEventsCount: span.droppedEvents,
  droppedLinksCount: span.droppedLinks,
});

/**
 * One OTLP resource per Span keeps each Span's own resource and scope; the batch's service
 * always wins over a `service.name` the sender put in the resource.
 */
export const selfTracesRequest = (service: string, spans: ReadonlyArray<SelfSpan>): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      resourceSpans: spans.map((span) => ({
        resource: { attributes: keyValues({ ...span.resource, "service.name": service }) },
        scopeSpans: [
          {
            scope: {
              name: span.scope.name,
              version: span.scope.version,
              attributes: keyValues(span.scope.attributes),
            },
            spans: [spanOf(span)],
          },
        ],
      })),
    })
  );
