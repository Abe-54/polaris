/**
 * The Daemon's Tracer (ENG-710): `Effect.fn`/`withSpan` Spans go straight to the trace store
 * as `polaris-daemon` Self-Traces while Developer Mode is effectively on.
 */
import type { SelfSpan, TraceAttributes } from "@polaris/protocol";
// Subpaths, not the root: it would load the whole Client runtime at the Daemon's start.
import { currentFiberSpan } from "@polaris/client/selfTraces/logger";
import {
  hookConsole,
  type LogConsole,
  type LogRecorder,
  makeLogRecorder,
} from "@polaris/client/selfTraces/logs";
import { Cause, Exit, Option, Predicate, Schema, Tracer } from "effect";
import { VERSION } from "../../service/platform.ts";

export const DAEMON_SERVICE = "polaris-daemon";

/** Spans waiting for the store; past this, new Spans are dropped until the next flush. */
export const MAX_BUFFERED_SPANS = 1024;

/**
 * A batch worth starting the store's worker for (ENG-721). Fewer wait in memory, with no timer,
 * until a read of the Self-Trace scope, a Developer Mode switch or shutdown flushes them.
 */
export const BATCH_SPANS = 64;

/**
 * Connection upkeep an idle Host repeats (ENG-721): never exported, nor their children, so a
 * Client's hello and lease renewals don't keep the trace store's worker alive.
 */
export const QUIET_SPANS: ReadonlySet<string> = new Set([
  "polaris.rpc.hello",
  "authenticateConnection",
  "polaris.rpc.presence.report",
  "polaris.rpc.developerMode.lease",
]);

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

/** Attribute values are whatever Effect code annotated; anything not JSON becomes a marker. */
const attributesOf = (entries: Iterable<readonly [string, unknown]>): TraceAttributes =>
  Object.fromEntries(
    Array.from(entries, ([key, value]) => [
      key,
      Predicate.isBigInt(value)
        ? value.toString()
        : Option.getOrElse(decodeJson(value), () => "[unserializable]"),
    ])
  );

const statusOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return { status: "ok" as const, statusMessage: "" };

  if (Cause.hasInterruptsOnly(exit.cause)) return { status: "unset" as const, statusMessage: "" };

  return { status: "error" as const, statusMessage: Cause.pretty(exit.cause).slice(0, 1024) };
};

export const selfSpanOf = (span: Tracer.NativeSpan): SelfSpan | null => {
  if (!Predicate.isTagged(span.status, "Ended")) return null;
  const { startTime, endTime, exit } = span.status;
  const parent = Option.getOrUndefined(span.parent);

  return {
    traceId: span.traceId,
    id: span.spanId,
    parentId: parent?.spanId ?? null,
    name: span.name,
    kind: span.kind,
    ...statusOf(exit),
    traceState: "",
    startTimeUnixNano: startTime.toString(),
    endTimeUnixNano: (endTime < startTime ? startTime : endTime).toString(),
    attributes: attributesOf(span.attributes),
    resource: { "service.version": VERSION },
    scope: { name: "polaris", version: VERSION, attributes: {} },
    events: span.events.map(([name, time, attributes]) => ({
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

export type SelfTraceSink = (spans: ReadonlyArray<SelfSpan>) => void;

/** Records one ended Span for its tracer; constructed only while exporting. */
class ExportedSpan extends Tracer.NativeSpan {
  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    private readonly owner: SelfTracer
  ) {
    super(options);
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    this.owner.record(this);
  }
}

/**
 * Off, `span` is the native tracer's: no exportable Span or buffer. The switch is a
 * plain field so every process-wide Span creation reads it live.
 */
export class SelfTracer implements Tracer.Tracer {
  private sink: SelfTraceSink | null = null;
  private buffer: SelfSpan[] = [];
  private unhook: (() => void) | null = null;

  dropped = 0;

  /** Warnings and errors, recorded while exporting (ENG-754); also the Effect logger's. */
  readonly logs: LogRecorder;

  /** `console` is hooked exactly while exporting. */
  constructor(private readonly console: LogConsole = globalThis.console) {
    this.logs = makeLogRecorder({
      enabled: () => this.exporting,
      emit: (span) => this.push(span),
      origin: () => ({ resource: {}, scope: { name: "polaris", version: "", attributes: {} } }),
    });
  }

  get exporting(): boolean {
    return this.sink !== null;
  }

  span(options: Parameters<Tracer.Tracer["span"]>[0]): Tracer.Span {
    // Unsampled, so the Spans under it are unsampled too.
    if (QUIET_SPANS.has(options.name)) return new Tracer.NativeSpan({ ...options, sampled: false });

    return this.sink === null || !options.sampled
      ? new Tracer.NativeSpan(options)
      : new ExportedSpan(options, this);
  }

  /** Spans recorded so far go to the previous sink; with null, exporting stops. */
  setSink(sink: SelfTraceSink | null): void {
    this.flush();
    this.unhook?.();
    this.sink = sink;
    this.unhook = sink === null ? null : hookConsole(this.console, this.logs, currentFiberSpan);
  }

  record(span: Tracer.NativeSpan): void {
    if (this.sink === null) return;
    const self = selfSpanOf(span);

    if (self !== null) this.push(self);
  }

  private push(self: SelfSpan): void {
    if (this.sink === null) return;

    if (this.buffer.length >= MAX_BUFFERED_SPANS) {
      this.dropped++;

      return;
    }

    this.buffer.push(self);

    if (this.buffer.length >= BATCH_SPANS) this.flush();
  }

  flush(): void {
    const spans = this.buffer;
    this.buffer = [];

    if (spans.length > 0) this.sink?.(spans);
  }
}

/** The Daemon's one Tracer, installed at the root of `serve` before any handler starts. */
export const selfTracer = new SelfTracer();
