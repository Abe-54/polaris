/** OTLP's JSON mapping after generated protobuf decoding; this is not a wire decoder. */
import { Schema } from "effect";

interface Value {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string | number;
  readonly doubleValue?: number | "NaN" | "Infinity" | "-Infinity";
  readonly bytesValue?: string;
  readonly arrayValue?: { readonly values?: ReadonlyArray<Value> };
  readonly kvlistValue?: { readonly values?: ReadonlyArray<KeyValue> };
}

interface KeyValue {
  readonly key: string;
  readonly value?: Value;
}

const Integer = Schema.Union([
  Schema.String.check(Schema.isPattern(/^-?\d+$/)),
  Schema.Int.check(
    Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })
  ),
]);

const AnyValue: Schema.Codec<Value> = Schema.Struct({
  stringValue: Schema.optionalKey(Schema.String),
  boolValue: Schema.optionalKey(Schema.Boolean),
  intValue: Schema.optionalKey(Integer),
  doubleValue: Schema.optionalKey(
    Schema.Union([Schema.Finite, Schema.Literals(["NaN", "Infinity", "-Infinity"])])
  ),
  bytesValue: Schema.optionalKey(Schema.String),
  arrayValue: Schema.optionalKey(
    Schema.Struct({ values: Schema.optionalKey(Schema.Array(Schema.suspend(() => AnyValue))) })
  ),
  kvlistValue: Schema.optionalKey(
    Schema.Struct({ values: Schema.optionalKey(Schema.Array(Schema.suspend(() => Attribute))) })
  ),
});

const Attribute: Schema.Codec<KeyValue> = Schema.Struct({
  key: Schema.String,
  value: Schema.optionalKey(AnyValue),
});

const Attributes = Schema.Array(Attribute);

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Time = Schema.Union([
  Schema.String.check(Schema.isPattern(/^\d+$/)),
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
]);

const Scope = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  attributes: Schema.optionalKey(Attributes),
});

const Resource = Schema.Struct({ attributes: Schema.optionalKey(Attributes) });

const Span = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optionalKey(Schema.String),
  traceState: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
  startTimeUnixNano: Time,
  endTimeUnixNano: Time,
  attributes: Schema.optionalKey(Attributes),
  status: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
      message: Schema.optionalKey(Schema.String),
    })
  ),
  events: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        timeUnixNano: Time,
        attributes: Schema.optionalKey(Attributes),
        droppedAttributesCount: Schema.optionalKey(Count),
      })
    )
  ),
  links: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        traceId: Schema.String,
        spanId: Schema.String,
        traceState: Schema.optionalKey(Schema.String),
        attributes: Schema.optionalKey(Attributes),
        droppedAttributesCount: Schema.optionalKey(Count),
      })
    )
  ),
  droppedAttributesCount: Schema.optionalKey(Count),
  droppedEventsCount: Schema.optionalKey(Count),
  droppedLinksCount: Schema.optionalKey(Count),
});

const Log = Schema.Struct({
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String),
  timeUnixNano: Schema.optionalKey(Time),
  observedTimeUnixNano: Schema.optionalKey(Time),
  severityNumber: Schema.optionalKey(Count),
  severityText: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(AnyValue),
  attributes: Schema.optionalKey(Attributes),
  droppedAttributesCount: Schema.optionalKey(Count),
});

export const ExportTraces = Schema.Struct({
  resourceSpans: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        resource: Schema.optionalKey(Resource),
        scopeSpans: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              scope: Schema.optionalKey(Scope),
              spans: Schema.optionalKey(Schema.Array(Span)),
            })
          )
        ),
      })
    )
  ),
});

export const ExportLogs = Schema.Struct({
  resourceLogs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        resource: Schema.optionalKey(Resource),
        scopeLogs: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              scope: Schema.optionalKey(Scope),
              logRecords: Schema.optionalKey(Schema.Array(Log)),
            })
          )
        ),
      })
    )
  ),
});

export type OtlpValue = Value;

export type OtlpAttribute = KeyValue;

export type OtlpScope = typeof Scope.Type;

export type OtlpSpan = typeof Span.Type;

export type OtlpLog = typeof Log.Type;
