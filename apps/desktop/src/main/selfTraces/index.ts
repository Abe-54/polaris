/**
 * The Desktop App's Self-Traces (ADR 0095): main's Spans (the Client runtime's included) and the
 * renderer's, sent to the Polaris Workspace's Host while its Developer Mode is effective.
 */
import {
  currentFiberSpan,
  gatedTracer,
  DEFAULT_FLUSH_DELAY_MS,
  hookConsole,
  type LogConsole,
  makeLogRecorder,
  makeSelfTraceExporter,
  type SelfTraceClock,
  type SelfTraceSendOutcome,
  selfSpanOf,
  selfTraceLoggers,
  systemClock,
  traceParentIds,
} from "@polaris/client";
import {
  SELF_TRACE_BATCH_SPANS,
  SelfSpan,
  type SelfTraceBatch,
  type TraceContext,
} from "@polaris/protocol";
import { Effect, Layer, Logger, Schema, Tracer } from "effect";
import { RpcClient } from "effect/rpc";
import type { DeveloperModeSource } from "./source.ts";

export const MAIN_SERVICE = "polaris-desktop-main";

export const RENDERER_SERVICE = "polaris-desktop-renderer";

const RendererSpans = Schema.Array(SelfSpan).check(Schema.isMaxLength(SELF_TRACE_BATCH_SPANS));

/** Decodes what a renderer sent on `CHANNELS.selfSpans`; untrusted until it does. */
export const decodeRendererSpans = Schema.decodeUnknownOption(RendererSpans);

export type SelfTraceSender = (
  hostKey: string,
  batch: SelfTraceBatch
) => Promise<SelfTraceSendOutcome>;

export interface DesktopSelfTracesOptions {
  readonly version: string;
  /** The Polaris Workspace's Host and its effective Developer Mode, followed live. */
  readonly source: DeveloperModeSource;
  readonly clock?: SelfTraceClock;
  readonly flushDelayMs?: number;
  /** Whose `warn` and `error` are recorded while on; the process's console by default. */
  readonly console?: LogConsole;
}

export interface DesktopSelfTraces {
  /** The main process's Tracer: records only while on. */
  readonly tracer: Tracer.Tracer;
  /** The Tracer and the loggers that record Warning and above, for the Client runtime. */
  readonly layer: Layer.Layer<never>;
  readonly enabled: () => boolean;
  /** Spans the renderer sent over IPC, decoded; ignored while off. */
  readonly ingestRenderer: (spans: ReadonlyArray<SelfSpan>) => void;
  /** Runs an IPC request inside the renderer's Trace while on. */
  readonly withRendererTrace: <A, E, R>(
    trace: TraceContext | undefined,
    method: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly onChange: (listener: (enabled: boolean) => void) => () => void;
  /** Until bound, batches wait as they would for an unreachable Host. */
  readonly bind: (send: SelfTraceSender) => void;
  /** Sends held Spans now (tests, and before quitting). */
  readonly flush: () => Promise<void>;
  /** Stops following the source. */
  readonly dispose: () => void;
}

export const createDesktopSelfTraces = (options: DesktopSelfTracesOptions): DesktopSelfTraces => {
  const { source } = options;
  const listeners = new Set<(enabled: boolean) => void>();
  let sender: SelfTraceSender | null = null;

  const exporter = makeSelfTraceExporter({
    send: (batch) =>
      sender === null ? Promise.resolve("unreachable") : sender(source.current().hostKey, batch),
    clock: options.clock ?? systemClock,
    flushDelayMs: options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS,
    log: (message) => console.warn("[self-traces]", message),
  });

  const origin = { service: MAIN_SERVICE, version: options.version, scope: "@polaris/desktop" };

  const tracer = gatedTracer({
    enabled: exporter.enabled,
    onEnd: (span) => {
      const self = selfSpanOf(span, origin);

      if (self !== null) exporter.record(MAIN_SERVICE, self);
    },
  });

  const logs = makeLogRecorder({
    enabled: exporter.enabled,
    emit: (span) => exporter.record(MAIN_SERVICE, span),
    origin: () => ({
      resource: { "service.name": MAIN_SERVICE, "service.version": options.version },
      scope: { name: origin.scope, version: options.version, attributes: {} },
    }),
    nowMs: (options.clock ?? systemClock).now,
  });

  const target = options.console ?? globalThis.console;
  let unhook: (() => void) | null = null;

  const follow = (enabled: boolean) => {
    if (enabled === exporter.enabled()) return;
    exporter.setEnabled(enabled);
    unhook?.();
    unhook = enabled ? hookConsole(target, logs, currentFiberSpan) : null;

    for (const listener of listeners) listener(enabled);
  };

  follow(source.current().enabled);
  const unsubscribe = source.subscribe((gate) => follow(gate.enabled));

  const ingestRenderer = (spans: ReadonlyArray<SelfSpan>) => {
    if (!exporter.enabled()) return;

    for (const span of spans) exporter.record(RENDERER_SERVICE, span);
  };

  const withRendererTrace = <A, E, R>(
    trace: TraceContext | undefined,
    method: string,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> => {
    if (trace === undefined || !exporter.enabled()) return effect;
    const parent = Tracer.externalSpan(traceParentIds(trace.traceparent));
    const traced = Effect.withSpan(effect, `ipc.${method}`, { kind: "server", parent });

    return trace.tracestate === undefined
      ? traced
      : RpcClient.withHeaders(traced, { tracestate: trace.tracestate });
  };

  return {
    tracer,
    layer: Layer.mergeAll(
      Layer.succeed(Tracer.Tracer, tracer),
      Layer.succeed(Logger.CurrentLoggers, selfTraceLoggers(logs))
    ),
    enabled: exporter.enabled,
    ingestRenderer,
    withRendererTrace,
    onChange: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    bind: (send) => {
      sender = send;
    },
    flush: exporter.flush,
    dispose: () => {
      unsubscribe();
      unhook?.();
      unhook = null;
    },
  };
};
