/**
 * `trace_capture`: holds the tool call for a window, or until a Span whose name matches ends,
 * woken by the trace store's writes. No timer runs outside a call.
 */
import type { TraceError } from "@polaris/protocol";
import { Clock, Effect, Option, Stream } from "effect";
import type { TraceStore } from "../../traces/index.ts";
import { CAPTURE_SPAN_CAP, type SpanCapture } from "../../traces/capture.ts";
import { SELF_CHECKOUT } from "../../traces/self/scope.ts";

/**
 * Late batches still arriving after the window. Self-Traces: the renderer's 1 s flush, then main's
 * 1 s, plus transport; a checkout: the OpenTelemetry batch processor's 5 s default, plus transport.
 */
export const CAPTURE_GRACE_MS = { self: 2_500, checkout: 5_500 } as const;

/** Between `until` checks while writes keep coming; writes in the gap fold into one check. */
const PROBE_GAP_MS = 100;

export interface CaptureOptions {
  readonly seconds: number;
  /** A Span name substring: the window closes once a matching Span has ended. */
  readonly until?: string;
  /** Overrides the scope's grace (tests). */
  readonly graceMs?: number;
}

export interface CaptureResult {
  readonly capture: SpanCapture;
  readonly startMs: number;
  readonly endMs: number;
  /** Whether `until` matched before the window ran out; null without `until`. */
  readonly matched: boolean | null;
}

const waitForMatch = (
  store: TraceStore["Service"],
  checkout: string,
  sinceMs: number,
  name: string,
  timeoutMs: number
) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Subscribe first, so a batch written during the first check still wakes the wait.
      const changes = yield* store.changes;

      const probe = Effect.map(
        store.capture(checkout, { sinceMs, untilMs: Number.MAX_SAFE_INTEGER, name, cap: 1 }),
        (found) => found.spans.length > 0
      );

      if (yield* probe) return true;

      const found = yield* changes.pipe(
        Stream.mapEffect(() =>
          Effect.flatMap(probe, (hit) =>
            hit ? Effect.succeed(true) : Effect.as(Effect.sleep(PROBE_GAP_MS), false)
          )
        ),
        Stream.filter((hit) => hit),
        Stream.runHead,
        Effect.timeoutOption(timeoutMs)
      );

      return Option.isSome(Option.flatten(found));
    })
  );

export const captureSpans = Effect.fnUntraced(function* (
  store: TraceStore["Service"],
  checkout: string,
  options: CaptureOptions
): Effect.fn.Return<CaptureResult, TraceError> {
  const startMs = yield* Clock.currentTimeMillis;
  const windowMs = options.seconds * 1_000;

  const matched =
    options.until === undefined
      ? null
      : yield* waitForMatch(store, checkout, startMs, options.until, windowMs);

  if (matched === null) yield* Effect.sleep(windowMs);
  const endMs = yield* Clock.currentTimeMillis;
  const scope = checkout === SELF_CHECKOUT ? "self" : "checkout";

  yield* Effect.sleep(options.graceMs ?? CAPTURE_GRACE_MS[scope]);

  const capture = yield* store.capture(checkout, {
    sinceMs: startMs,
    untilMs: endMs,
    cap: CAPTURE_SPAN_CAP,
  });

  return { capture, startMs, endMs, matched };
});
