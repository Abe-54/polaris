/**
 * Effect's side of log capture (ENG-754): a logger that sends Warning and above through the
 * recorder and leaves the rest to Effect's tracer logger, and the Span a fiber is running in.
 */
import { Cause, Fiber, Logger, Match, Predicate, type LogLevel as EffectLogLevel } from "effect";
import type { LogLevel, LogRecorder, LogTarget } from "./logs.ts";

const levelOf = Match.type<EffectLogLevel.LogLevel>().pipe(
  Match.when("Warn", (): LogLevel | null => "warn"),
  Match.whenOr("Error", "Fatal", (): LogLevel | null => "error"),
  Match.orElse(() => null)
);

/** The Span `fiber` runs in, when it is one this process made (not a remote parent). */
export const fiberSpan = (
  fiber: Fiber.Fiber<unknown, unknown> | undefined
): LogTarget | undefined => {
  const span = fiber?.cache.span;

  return Predicate.isTagged(span, "Span") ? span : undefined;
};

/** The Span of the fiber running now, for `hookConsole`. */
export const currentFiberSpan = (): LogTarget | undefined => fiberSpan(Fiber.getCurrent());

/**
 * Replaces Effect's `tracerLogger`: off, or below Warning, it behaves the same; on, Warning and
 * above are recorded with the recorder's caps, rate limit and fallback Span.
 */
export const selfTraceLogger = (recorder: LogRecorder): Logger.Logger<unknown, void> =>
  Logger.make((options) => {
    const level = levelOf(options.logLevel);

    if (level === null || !recorder.enabled()) return Logger.tracerLogger.log(options);

    const messages: ReadonlyArray<unknown> = Array.isArray(options.message)
      ? options.message
      : [options.message];

    const { cause } = options;
    const args = cause.reasons.length > 0 ? [...messages, Cause.pretty(cause)] : messages;

    recorder.record(level, "effect", args, fiberSpan(options.fiber));
  });

/** The loggers a process runs with: Effect's default console logger and the Self-Trace one. */
export const selfTraceLoggers = (
  recorder: LogRecorder
): ReadonlySet<Logger.Logger<unknown, unknown>> =>
  new Set([Logger.defaultLogger, selfTraceLogger(recorder)]);
