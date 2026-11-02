/**
 * Self-Trace ingest (ENG-711, ADR 0095): Clients send batches of their own Spans to the Host
 * that holds the Polaris Workspace. Capability `traces.self`, advertised only once implemented.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { dataJsonBytes } from "./dataValues.ts";
import { Unsupported } from "./errors.ts";
import { Span } from "./traces.ts";

export const SELF_TRACES_CAPABILITY = "traces.self";

/** The most one `traces.ingestSelf` call may carry, measured as its encoded JSON payload. */
export const SELF_TRACE_BATCH_BYTES = 512 * 1024;

export const SELF_TRACE_BATCH_SPANS = 1024;

/** The services Polaris's own processes report as; other names are accepted for later ones. */
export const SELF_TRACE_SERVICES = [
  "polaris-daemon",
  "polaris-desktop-main",
  "polaris-desktop-renderer",
  "polaris-mobile",
] as const;

export const SelfTraceService = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

/**
 * A Span as the sending process recorded it: the trace store's `Span` without what the Daemon
 * derives (`durationMs`, `service` from the batch, `polaris` attribution).
 */
export const SelfSpan = Schema.Struct({
  traceId: Span.fields.traceId,
  id: Span.fields.id,
  parentId: Span.fields.parentId,
  name: Span.fields.name,
  kind: Span.fields.kind,
  status: Span.fields.status,
  statusMessage: Span.fields.statusMessage,
  traceState: Span.fields.traceState,
  startTimeUnixNano: Span.fields.startTimeUnixNano,
  endTimeUnixNano: Span.fields.endTimeUnixNano,
  attributes: Span.fields.attributes,
  resource: Span.fields.resource,
  scope: Span.fields.scope,
  events: Span.fields.events,
  links: Span.fields.links,
  droppedAttributes: Span.fields.droppedAttributes,
  droppedEvents: Span.fields.droppedEvents,
  droppedLinks: Span.fields.droppedLinks,
});

export type SelfSpan = typeof SelfSpan.Type;

export const SelfTraceBatch = Schema.Struct({
  service: SelfTraceService,
  spans: Schema.Array(SelfSpan).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SELF_TRACE_BATCH_SPANS)
  ),
}).check(Schema.makeFilter((batch) => dataJsonBytes(batch) <= SELF_TRACE_BATCH_BYTES));

export type SelfTraceBatch = typeof SelfTraceBatch.Type;

export class SelfTraceRejected extends Schema.TaggedError<SelfTraceRejected>()(
  "SelfTraceRejected",
  {
    /**
     * `developer-mode-off`: the Host neither stores Developer Mode nor holds a lease. `busy`: the
     * trace store is busy; retry the batch later.
     */
    reason: Schema.Literals(["developer-mode-off", "storage", "busy"]),
    message: Schema.String,
  }
) {}

export const SelfTraceIngested = Schema.Struct({
  accepted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const IngestSelfTraces = Rpc.make("traces.ingestSelf", {
  payload: SelfTraceBatch,
  success: SelfTraceIngested,
  error: Schema.Union([Unsupported, SelfTraceRejected]),
});

export class SelfTraceRpcs extends RpcGroup.make(IngestSelfTraces) {}
