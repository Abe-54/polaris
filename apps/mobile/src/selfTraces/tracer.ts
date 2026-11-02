/**
 * The Mobile App's Self-Trace Tracer (ADR 0095), service `polaris-mobile`. It is on only while a
 * target is set: the Host holding the Polaris Workspace, with Developer Mode effective. While off
 * a Span is a no-op, commands carry no trace context, and no timer runs.
 */
import {
  type SelfSpan,
  type SelfTraceBatch,
  type TraceAttributes,
  type TraceContext,
  traceContextHeaders,
} from "@polaris/protocol";
import { Cause, Context, Effect, Exit } from "effect";
import { RpcClient } from "effect/rpc";
import { openSpanBuffer, type SpanBuffer, type SpanBufferLimits } from "./buffer.ts";
import app from "../../app.json";

export const MOBILE_SERVICE = "polaris-mobile";

/** The app release (app.json), so Self-Traces can be compared across builds. */
export const MOBILE_VERSION: string = app.expo.version;

/** How often buffered Spans are sent while on. */
export const FLUSH_INTERVAL_MS = 5_000;

const STATUS_MESSAGE_CHARS = 200;

/** `retry` keeps the batch for the next flush (the Host is unreachable); `dropped` doesn't. */
export type SendOutcome = "sent" | "retry" | "dropped";

export interface TraceTarget {
  readonly hostId: string;
  readonly send: (batch: SelfTraceBatch) => Promise<SendOutcome>;
}

export interface SelfSpanHandle {
  /** Null while off: the Span records nothing and commands carry no context. */
  readonly context: TraceContext | null;
  readonly end: (status?: "ok" | "error", message?: string) => void;
}

export interface SpanOptions {
  readonly parent?: SelfSpanHandle | null;
  /** `client` for a command sent to a Host; `internal` otherwise. */
  readonly kind?: "client" | "internal";
}

export interface SelfTracerRuntime {
  readonly now: () => number;
  readonly random: () => number;
  /** Calls `run` every `ms` until the returned stop is called. */
  readonly every: (run: () => void, ms: number) => () => void;
}

export interface SelfTracer {
  readonly on: () => boolean;
  readonly targetHostId: () => string | null;
  /** Null turns tracing off and drops whatever is buffered. */
  readonly setTarget: (target: TraceTarget | null) => void;
  readonly start: (
    name: string,
    attributes?: TraceAttributes,
    options?: SpanOptions
  ) => SelfSpanHandle;
  /** Runs `effect` in a client Span whose `traceparent` its RPCs carry; unchanged while off. */
  readonly traced: <A, E, R>(
    name: string,
    attributes: TraceAttributes,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  /** Sends what is buffered to the target, a batch at a time. */
  readonly flush: () => Promise<void>;
  readonly buffer: Pick<SpanBuffer, "spans" | "bytes">;
}

/** The Span a traced effect runs in, so nested traced work becomes its child. */
export const CurrentSelfSpan = Context.Reference<SelfSpanHandle | null>(
  "polaris/mobile/CurrentSelfSpan",
  { defaultValue: () => null }
);

const OFF_SPAN: SelfSpanHandle = { context: null, end: () => undefined };

const RESOURCE: TraceAttributes = {
  "service.name": MOBILE_SERVICE,
  "service.version": MOBILE_VERSION,
};

const SCOPE = { name: MOBILE_SERVICE, version: MOBILE_VERSION, attributes: {} };

const nanos = (ms: number) => `${Math.max(0, Math.round(ms))}000000`;

const parentIdOf = (context: TraceContext | null) => context?.traceparent.slice(36, 52) ?? null;

const traceIdOf = (context: TraceContext | null) => context?.traceparent.slice(3, 35) ?? null;

const defaultRuntime: SelfTracerRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  every: (run, ms) => {
    const handle = setInterval(run, ms);

    return () => clearInterval(handle);
  },
};

export const openSelfTracer = (
  runtime: SelfTracerRuntime = defaultRuntime,
  limits: SpanBufferLimits = {}
): SelfTracer => {
  const buffer = openSpanBuffer(limits);
  let target: TraceTarget | null = null;
  let stopTimer: (() => void) | null = null;
  let flushing = false;

  const hex = (length: number) => {
    let out = "";

    while (out.length < length) out += Math.floor(runtime.random() * 16).toString(16);

    // All zeros is invalid in W3C trace context; one fixed digit avoids it.
    return /^0+$/.test(out) ? `${out.slice(0, -1)}1` : out;
  };

  const start = (
    name: string,
    attributes: TraceAttributes = {},
    options: SpanOptions = {}
  ): SelfSpanHandle => {
    if (target === null) return OFF_SPAN;
    const parent = options.parent?.context ?? null;
    const traceId = traceIdOf(parent) ?? hex(32);
    const id = hex(16);
    const startedAt = runtime.now();
    let ended = false;

    return {
      context: { traceparent: `00-${traceId}-${id}-01` },
      end: (status = "ok", message = "") => {
        // A Span that ends after tracing went off is dropped with the rest.
        if (ended || target === null) return;
        ended = true;

        const endedAt = runtime.now();

        const span: SelfSpan = {
          traceId,
          id,
          parentId: parentIdOf(parent),
          name,
          kind: options.kind ?? "internal",
          status,
          statusMessage: message.slice(0, STATUS_MESSAGE_CHARS),
          traceState: "",
          startTimeUnixNano: nanos(startedAt),
          endTimeUnixNano: nanos(Math.max(startedAt, endedAt)),
          attributes,
          resource: RESOURCE,
          scope: SCOPE,
          events: [],
          links: [],
          droppedAttributes: 0,
          droppedEvents: 0,
          droppedLinks: 0,
        };

        buffer.push(span, endedAt);
      },
    };
  };

  const flush = async () => {
    const sending = target;

    if (sending === null || flushing) return;
    flushing = true;

    try {
      for (;;) {
        const batch = buffer.take(runtime.now());

        if (batch.length === 0) return;

        const outcome = await sending
          .send({ service: MOBILE_SERVICE, spans: batch.map((entry) => entry.span) })
          .catch((): SendOutcome => "retry");

        if (target === null) return;

        if (outcome === "retry") {
          buffer.restore(batch, runtime.now());

          return;
        }
      }
    } finally {
      flushing = false;
    }
  };

  const setTarget = (next: TraceTarget | null) => {
    target = next;

    if (next === null) {
      buffer.clear();

      stopTimer?.();
      stopTimer = null;

      return;
    }

    stopTimer ??= runtime.every(() => void flush(), FLUSH_INTERVAL_MS);
  };

  const traced = <A, E, R>(
    name: string,
    attributes: TraceAttributes,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      if (target === null) return effect;

      return Effect.flatMap(Effect.service(CurrentSelfSpan), (parent) => {
        const span = start(name, attributes, { parent, kind: "client" });

        return effect.pipe(
          RpcClient.withHeaders(traceContextHeaders(span.context)),
          Effect.provideService(CurrentSelfSpan, span),
          Effect.onExit((exit) =>
            Effect.sync(() =>
              Exit.isSuccess(exit)
                ? span.end("ok")
                : span.end("error", String(Cause.squash(exit.cause)))
            )
          )
        );
      });
    });

  return {
    on: () => target !== null,
    targetHostId: () => target?.hostId ?? null,
    setTarget,
    start,
    traced,
    flush,
    buffer: { spans: buffer.spans, bytes: buffer.bytes },
  };
};
