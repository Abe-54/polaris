/**
 * Request trace context (ENG-710, ADR 0095): a handler Span's parent comes only from the
 * `traceparent` header, never from Effect's own request fields.
 */
import { readTraceContext } from "@polaris/protocol";
import { Predicate } from "effect";
import type { FromClientEncoded } from "effect/rpc/RpcMessage";

/** Replaces Effect's `traceId`/`spanId`/`sampled` with the request's valid `traceparent`, or none. */
export const withRequestTraceContext = (message: FromClientEncoded): FromClientEncoded => {
  if (!Predicate.isTagged(message, "Request")) return message;
  const { traceId, spanId, sampled, ...request } = message;

  const context = readTraceContext(
    (name) => message.headers.find(([key]) => key.toLowerCase() === name)?.[1]
  );

  if (context === null)
    return traceId === undefined && spanId === undefined && sampled === undefined
      ? message
      : request;
  const parent = context.traceparent;

  return {
    ...request,
    traceId: parent.slice(3, 35),
    spanId: parent.slice(36, 52),
    sampled: (Number.parseInt(parent.slice(53, 55), 16) & 1) === 1,
  };
};
