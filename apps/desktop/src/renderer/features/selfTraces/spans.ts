/**
 * The renderer's Self-Traces (ADR 0095): Spans for what the user starts here, such as a Turn
 * from the composer, handed to main in batches. Off, no Span is made and nothing crosses IPC.
 */
import { hookConsole, type LogConsole, makeLogRecorder } from "@polaris/client/selfTraces/logs";
import type { SelfSpan, TraceContext } from "@polaris/protocol";
import type { PolarisApi } from "../../../shared/api.ts";

const FLUSH_MS = 1_000;

const RENDERER_SERVICE = "polaris-desktop-renderer";

const BATCH_SPANS = 1_024;

/** What a batch of Spans goes through; `selfSpans` is absent in previews and older preloads. */
type Bridge = Pick<PolarisApi, "selfSpans">;

export interface RendererSpan {
  /** Pass as the request's `trace`, so main and the Daemon join this Trace. */
  readonly trace: TraceContext;
  /** Ends the Span, now or at `atMs`; a message marks it failed, `attributes` add what was learned. */
  readonly end: (failure?: string, attributes?: SpanAttributes, atMs?: number) => void;
}

type SpanAttributes = Record<string, string | number | boolean>;

export interface RendererSelfTracesOptions {
  readonly bridge: () => Bridge;
  readonly nowMs?: () => number;
  /** Arms a timer; the result cancels it. */
  readonly setTimeout?: (run: () => void, ms: number) => () => void;
  /** Whose `warn` and `error` become `polaris.log` Spans while on; the window's by default. */
  readonly console?: LogConsole;
}

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

const nanos = (ms: number) => (BigInt(Math.round(ms * 1_000)) * 1_000n).toString();

export const createRendererSelfTraces = ({
  bridge,
  nowMs = () => performance.timeOrigin + performance.now(),
  setTimeout: arm = (run, ms) => {
    const handle = globalThis.setTimeout(run, ms);

    return () => globalThis.clearTimeout(handle);
  },
  console: target = globalThis.console,
}: RendererSelfTracesOptions) => {
  let enabled = false;
  let version = "";
  let pending: Array<SelfSpan> = [];
  let cancelTimer: (() => void) | null = null;

  const flush = () => {
    cancelTimer = null;
    const batch = pending.splice(0, BATCH_SPANS);

    if (batch.length > 0 && enabled) bridge().selfSpans?.(batch);

    if (pending.length > 0) cancelTimer = arm(flush, 0);
  };

  const resource = () => ({ "service.name": RENDERER_SERVICE, "service.version": version });
  const scope = () => ({ name: "@polaris/desktop/renderer", version, attributes: {} });

  const push = (span: SelfSpan) => {
    pending.push(span);

    if (cancelTimer === null) cancelTimer = arm(flush, FLUSH_MS);
  };

  const logs = makeLogRecorder({
    enabled: () => enabled,
    emit: push,
    origin: () => ({ resource: resource(), scope: scope() }),
    nowMs,
  });

  let unhook: (() => void) | null = null;

  const setEnabled = (on: boolean) => {
    if (on !== enabled) {
      unhook?.();
      unhook = on ? hookConsole(target, logs) : null;
    }

    enabled = on;

    if (on) return;
    pending = [];
    cancelTimer?.();
    cancelTimer = null;
  };

  /** A Span that has started now, or null while Self-Traces are off. */
  const start = (
    name: string,
    attributes: SpanAttributes = {},
    parent?: TraceContext
  ): RendererSpan | null => {
    if (!enabled) return null;
    const traceId = parent?.traceparent.slice(3, 35) ?? hex(16);
    const id = hex(8);
    const started = nowMs();

    const end = (failure?: string, more?: SpanAttributes, atMs?: number) => {
      if (!enabled) return;
      push({
        traceId,
        id,
        parentId: parent?.traceparent.slice(36, 52) ?? null,
        name,
        kind: "client",
        status: failure === undefined ? "unset" : "error",
        statusMessage: failure ?? "",
        traceState: "",
        startTimeUnixNano: nanos(started),
        endTimeUnixNano: nanos(Math.max(started, atMs ?? nowMs())),
        attributes: more === undefined ? attributes : { ...attributes, ...more },
        resource: resource(),
        scope: scope(),
        events: [],
        links: [],
        droppedAttributes: 0,
        droppedEvents: 0,
        droppedLinks: 0,
      });
    };

    return { trace: { traceparent: `00-${traceId}-${id}-01` }, end };
  };

  return {
    enabled: () => enabled,
    setEnabled,
    setVersion: (next: string) => {
      version = next;
    },
    start,
    flush,
    now: nowMs,
  };
};

export type RendererSelfTraces = ReturnType<typeof createRendererSelfTraces>;

type Api = Pick<PolarisApi, "request" | "onAppEvent" | "selfSpans">;

let current: RendererSelfTraces | null = null;

/** The window's Self-Traces, or null before `connectSelfTraces` (previews, tests). */
export const selfTraces = (): RendererSelfTraces | null => current;

/** Follows main's switch: the state now, then each `self-traces` App event. */
export const connectSelfTraces = (api: Api): RendererSelfTraces => {
  const traces = createRendererSelfTraces({ bridge: () => api });
  let heard = false;

  current = traces;
  api.onAppEvent((event) => {
    if (event.kind !== "self-traces") return;
    heard = true;
    traces.setEnabled(event.enabled);
  });
  void api.request("selfTraces.state", {}).then((result) => {
    if (!result.ok) return;
    traces.setVersion(result.value.version);

    // An App event that arrived first is newer than this answer.
    if (!heard) traces.setEnabled(result.value.enabled);
  });

  return traces;
};
