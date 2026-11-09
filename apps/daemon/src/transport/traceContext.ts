/**
 * Request trace context (ENG-710, ADR 0095): a handler Span's parent comes only from the
 * `traceparent` header, never from Effect's own request fields. A stream's handler Span
 * links to the Client's Span instead (ENG-732): that Span ends only with the stream.
 */
import { readTraceContext } from "@polaris/protocol";
import { Context, Effect, Predicate, Tracer } from "effect";
import type { FromClientEncoded } from "effect/rpc/RpcMessage";

export interface RequestTraceContext {
  readonly message: FromClientEncoded;
  /** The Client Span a stream's handler Span links to, or null. */
  readonly link: Tracer.ExternalSpan | null;
}

/**
 * Replaces Effect's `traceId`/`spanId`/`sampled` with the request's valid `traceparent`, or none.
 * For a stream (`isStream` of its tag) the `traceparent` becomes a link instead of the parent.
 */
export const withRequestTraceContext = (
  message: FromClientEncoded,
  isStream: (tag: string) => boolean
): RequestTraceContext => {
  if (!Predicate.isTagged(message, "Request")) return { message, link: null };
  const { traceId, spanId, sampled, ...request } = message;

  const context = readTraceContext(
    (name) => message.headers.find(([key]) => key.toLowerCase() === name)?.[1]
  );

  if (context === null)
    return {
      message:
        traceId === undefined && spanId === undefined && sampled === undefined ? message : request,
      link: null,
    };
  const parent = context.traceparent;

  const client = {
    traceId: parent.slice(3, 35),
    spanId: parent.slice(36, 52),
    sampled: (Number.parseInt(parent.slice(53, 55), 16) & 1) === 1,
  };

  if (!isStream(message.tag)) return { message: { ...request, ...client }, link: null };

  return {
    message: request,
    // DisablePropagation: the Span links to it but never takes it as a parent.
    link: Tracer.externalSpan({
      ...client,
      annotations: Context.make(Tracer.DisablePropagation, true),
    }),
  };
};

/**
 * Runs `write` so that Effect's RPC server links the request's handler Span to `link`
 * (it links to the writing fiber's parent Span) without parenting it there.
 */
export const linkedTo =
  (link: Tracer.ExternalSpan | null) =>
  <A, E, R>(write: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    link === null ? write : Effect.withParentSpan(write, link);
