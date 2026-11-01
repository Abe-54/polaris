/**
 * W3C trace context on RPC requests (ENG-711, ADR 0095): `traceparent` and `tracestate` travel
 * as request headers, only while Developer Mode is on. A malformed value is dropped, never fatal.
 */
import { Option, Schema } from "effect";

export const TRACEPARENT_HEADER = "traceparent";

export const TRACESTATE_HEADER = "tracestate";

/** W3C's minimum to propagate, and the most a Daemon keeps. */
export const MAX_TRACESTATE_BYTES = 512;

export const MAX_TRACESTATE_MEMBERS = 32;

const ZERO_TRACE = "0".repeat(32);

const ZERO_SPAN = "0".repeat(16);

/** Version 00 only: `00-<trace id>-<parent span id>-<flags>`, lowercase, no all-zero ids. */
export const TraceParent = Schema.String.check(
  Schema.isPattern(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
  Schema.makeFilter(
    (value) => value.slice(3, 35) !== ZERO_TRACE && value.slice(36, 52) !== ZERO_SPAN
  )
);

export type TraceParent = typeof TraceParent.Type;

const TRACESTATE_MEMBER =
  /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

const validTraceState = (value: string) => {
  const members = value.split(",").map((member) => member.trim());

  return (
    members.length <= MAX_TRACESTATE_MEMBERS &&
    members.every((member) => TRACESTATE_MEMBER.test(member))
  );
};

/** ASCII only, so its length is its byte count. */
export const TraceState = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_TRACESTATE_BYTES),
  Schema.makeFilter(validTraceState)
);

export type TraceState = typeof TraceState.Type;

export const TraceContext = Schema.Struct({
  traceparent: TraceParent,
  tracestate: Schema.optionalKey(TraceState),
});

export type TraceContext = typeof TraceContext.Type;

const decodeParent = Schema.decodeUnknownOption(TraceParent);

const decodeState = Schema.decodeUnknownOption(TraceState);

/**
 * The context a request's headers carry, or null without a valid `traceparent`. An invalid
 * `tracestate` is dropped on its own, as W3C asks.
 */
export const readTraceContext = (
  header: (name: string) => string | undefined
): TraceContext | null => {
  const parent = decodeParent(header(TRACEPARENT_HEADER));

  if (Option.isNone(parent)) return null;
  const state = decodeState(header(TRACESTATE_HEADER));

  return Option.isSome(state)
    ? { traceparent: parent.value, tracestate: state.value }
    : { traceparent: parent.value };
};

/** Request headers for a context; none when there is none (Developer Mode off). */
export const traceContextHeaders = (
  context: TraceContext | null
): ReadonlyArray<readonly [string, string]> => {
  if (context === null) return [];

  return context.tracestate === undefined
    ? [[TRACEPARENT_HEADER, context.traceparent]]
    : [
        [TRACEPARENT_HEADER, context.traceparent],
        [TRACESTATE_HEADER, context.tracestate],
      ];
};
