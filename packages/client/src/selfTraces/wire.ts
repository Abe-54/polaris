/**
 * W3C trace context on outgoing RPC requests (ADR 0095): while Self-Traces are on a request
 * carries its RPC Span as `traceparent`; while off it carries no trace context at all.
 */
import { TRACEPARENT_HEADER, TRACESTATE_HEADER } from "@polaris/protocol";
import type { RequestEncoded } from "effect/rpc/RpcMessage";
import { traceParentOf } from "./span.ts";

const isTraceHeader = ([name]: readonly [string, string]) => {
  const lower = name.toLowerCase();

  return lower === TRACEPARENT_HEADER || lower === TRACESTATE_HEADER;
};

/** The request as sent: a `tracestate` set by the caller survives only beside a `traceparent`. */
export const withTraceContext = (request: RequestEncoded, on: boolean): RequestEncoded => {
  const { traceId, spanId, sampled, ...rest } = request;
  const others = request.headers.filter((header) => !isTraceHeader(header));
  const traceparent = on ? traceParentOf({ traceId, spanId, sampled }) : null;

  if (traceparent === null) return { ...rest, headers: others };
  const state = request.headers.find(([name]) => name.toLowerCase() === TRACESTATE_HEADER);
  const headers: Array<[string, string]> = [...others, [TRACEPARENT_HEADER, traceparent]];

  if (state !== undefined) headers.push([TRACESTATE_HEADER, state[1]]);

  return { ...request, headers };
};
