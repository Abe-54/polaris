/**
 * Warnings and errors as Self-Trace data (ENG-754): while Self-Traces are on, a `console.warn` or
 * `console.error` becomes an event on the active Span, else a short `polaris.log` Span. Bounded:
 * messages are capped, a process records at most a few per second, and the rest are counted.
 */
import type { SelfSpan, TraceAttributes } from "@polaris/protocol";
import { Formatter, Match, Predicate } from "effect";
import { redactText } from "../redact.ts";

export type LogLevel = "warn" | "error";

/** Where the record came from: the console or an Effect logger. */
export type LogSource = "console" | "effect";

/** A Span that can take an event, such as Effect's native Span. */
export interface LogTarget {
  readonly event: (name: string, startTime: bigint, attributes?: TraceAttributes) => void;
}

export const LOG_SPAN_NAME = "polaris.log";

export const LOG_DROPPED_EVENT = "log.dropped";

export const LOG_MESSAGE_CHARS = 2048;

export const LOG_EVENTS_PER_SECOND = 20;

/** The exporter's own warnings start with this; recording them could feed back into export. */
export const SELF_TRACES_LOG_PREFIX = "[self-traces]";

export interface LogSpanOrigin {
  readonly resource: TraceAttributes;
  readonly scope: SelfSpan["scope"];
}

export interface LogRecorderOptions {
  readonly enabled: () => boolean;
  /** A `polaris.log` Span for a record made outside any Span. */
  readonly emit: (span: SelfSpan) => void;
  /** Read for each Span, so a version learned later still applies. */
  readonly origin: () => LogSpanOrigin;
  /** Replaces secrets before the message is clipped or kept; `redactText` by default. */
  readonly scrub?: (text: string) => string;
  readonly nowMs?: () => number;
  readonly perSecond?: number;
  readonly maxChars?: number;
}

export interface LogRecorder {
  readonly enabled: () => boolean;
  /** Records `args` as one message on `target`, else as a `polaris.log` Span; never throws. */
  readonly record: (
    level: LogLevel,
    source: LogSource,
    args: ReadonlyArray<unknown>,
    target?: LogTarget
  ) => void;
}

const nanos = (ms: number) => BigInt(Math.floor(ms)) * 1_000_000n;

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

const text = Match.type<ReadonlyArray<unknown>[number]>().pipe(
  Match.when(Predicate.isString, (value) => value),
  Match.when(Predicate.isError, (error) => error.stack ?? `${error.name}: ${error.message}`),
  Match.orElse((value) => Formatter.format(value))
);

/** How much of the arguments is read before scrubbing, as a multiple of the clip. */
const READ_FACTOR = 4;

/**
 * The arguments as one line of at most `limit` characters. Past the limit it ends at the last
 * whitespace before it, so a token the limit cuts never reaches the scrubber half-read.
 */
const joinArgs = (args: ReadonlyArray<unknown>, limit: number): string => {
  let joined = "";

  for (const value of args) {
    if (joined.length > limit) break;
    joined += (joined === "" ? "" : " ") + text(value);
  }

  return joined.length > limit ? joined.slice(0, limit).replace(/\s*\S*$/, "") : joined;
};

const clip = (message: string, max: number) =>
  message.length > max ? `${message.slice(0, max - 1)}…` : message;

/**
 * The console's arguments as one scrubbed line of at most `max` characters. Scrubbing runs
 * before the clip, so a secret the clip would cut in half is still matched whole.
 */
export const logMessage = (
  args: ReadonlyArray<unknown>,
  scrub: (text: string) => string = redactText,
  max = LOG_MESSAGE_CHARS
): string => clip(scrub(joinArgs(args, max * READ_FACTOR)), max);

/** A zero-length Span that stands for one log record outside any Span. */
export const logSpan = (
  attributes: TraceAttributes,
  timeMs: number,
  origin: LogSpanOrigin,
  failure?: string
): SelfSpan => {
  const at = nanos(timeMs).toString();

  return {
    traceId: hex(16),
    id: hex(8),
    parentId: null,
    name: LOG_SPAN_NAME,
    kind: "internal",
    status: failure === undefined ? "unset" : "error",
    statusMessage: failure ?? "",
    traceState: "",
    startTimeUnixNano: at,
    endTimeUnixNano: at,
    attributes,
    resource: origin.resource,
    scope: origin.scope,
    events: [],
    links: [],
    droppedAttributes: 0,
    droppedEvents: 0,
    droppedLinks: 0,
  };
};

const isOwnWarning = (args: ReadonlyArray<unknown>) =>
  Predicate.isString(args[0]) && args[0].startsWith(SELF_TRACES_LOG_PREFIX);

export const makeLogRecorder = ({
  enabled,
  emit,
  origin,
  scrub = redactText,
  nowMs = () => Date.now(),
  perSecond = LOG_EVENTS_PER_SECOND,
  maxChars = LOG_MESSAGE_CHARS,
}: LogRecorderOptions): LogRecorder => {
  let windowStart = Number.NEGATIVE_INFINITY;
  let count = 0;
  let dropped = 0;
  let busy = false;

  const deliver = (
    name: string,
    attributes: TraceAttributes,
    timeMs: number,
    target: LogTarget | undefined,
    failure?: string
  ) => {
    if (target === undefined) emit(logSpan(attributes, timeMs, origin(), failure));
    else target.event(name, nanos(timeMs), attributes);
  };

  /** Opens a new one-second window, first reporting what the last one dropped. */
  const roll = (timeMs: number, target: LogTarget | undefined) => {
    windowStart = timeMs;
    count = 0;

    if (dropped === 0) return;
    deliver(LOG_DROPPED_EVENT, { "log.dropped": dropped }, timeMs, target);
    dropped = 0;
  };

  const accept = (
    level: LogLevel,
    source: LogSource,
    args: ReadonlyArray<unknown>,
    target: LogTarget | undefined
  ) => {
    const timeMs = nowMs();

    if (timeMs - windowStart >= 1_000) roll(timeMs, target);

    if (count >= perSecond) {
      dropped += 1;

      return;
    }

    count += 1;
    const message = logMessage(args, scrub, maxChars);
    const attributes = { "log.severity": level, "log.source": source, "log.message": message };

    deliver(`log.${level}`, attributes, timeMs, target, level === "error" ? message : undefined);
  };

  return {
    enabled,
    record: (level, source, args, target) => {
      if (busy || !enabled() || isOwnWarning(args)) return;

      busy = true;

      try {
        accept(level, source, args, target);
      } catch {
        // A log record must never break the code that logged.
      } finally {
        busy = false;
      }
    },
  };
};

/** The console methods hooked; a structural type so tests pass a fake console. */
export interface LogConsole {
  warn: (...args: Array<unknown>) => void;
  error: (...args: Array<unknown>) => void;
}

/**
 * Hooks `target`'s `warn` and `error` to also record; the result unhooks, unless something else
 * replaced them since. `activeSpan` names the Span a call made now belongs to.
 */
export const hookConsole = (
  target: LogConsole,
  recorder: LogRecorder,
  activeSpan: () => LogTarget | undefined = () => undefined
): (() => void) => {
  const original = { warn: target.warn, error: target.error };

  const hook =
    (level: LogLevel) =>
    (...args: Array<unknown>) => {
      original[level].apply(target, args);
      recorder.record(level, "console", args, activeSpan());
    };

  const warn = hook("warn");
  const error = hook("error");

  target.warn = warn;
  target.error = error;

  return () => {
    if (target.warn === warn) target.warn = original.warn;

    if (target.error === error) target.error = original.error;
  };
};
