/** A Send's root client Span (ADR 0098): `traceparent` for the wire and the Span for the store. */
import { randomBytes } from "node:crypto";
import {
  TRACEPARENT_HEADER,
  TraceParent,
  type HttpHeader,
  type SelfSpan,
  type SendOutcome,
} from "@polaris/protocol";
import { Option, Schema } from "effect";
import { selfTracesRequest } from "../traces/self/otlp.ts";

export const SEND_SERVICE = "polaris";

export const SEND_SPAN_NAME = "send";

const decodeParent = Schema.decodeUnknownOption(TraceParent);

export interface SendTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  /** The headers to send: the Request's own, plus `traceparent` unless it set one. */
  readonly headers: ReadonlyArray<HttpHeader>;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** Reuses the trace id of a Request's own valid `traceparent`; otherwise injects a new one. */
export const sendTraceContext = (headers: ReadonlyArray<HttpHeader>): SendTraceContext => {
  const spanId = hex(8);
  const own = headers.find((header) => header.name.toLowerCase() === TRACEPARENT_HEADER);

  if (own !== undefined) {
    const parsed = decodeParent(own.value.trim());
    const traceId = Option.isSome(parsed) ? parsed.value.slice(3, 35) : hex(16);

    return { traceId, spanId, headers };
  }

  const traceId = hex(16);

  return {
    traceId,
    spanId,
    headers: [...headers, { name: TRACEPARENT_HEADER, value: `00-${traceId}-${spanId}-01` }],
  };
};

export interface RootSpanInput {
  readonly context: SendTraceContext;
  readonly method: string;
  /** Already masked: the store's redactor runs again, but never sees a resolved secret. */
  readonly url: string;
  readonly status?: number;
  readonly outcome: SendOutcome;
  readonly errorMessage?: string;
  readonly sendId: string;
  readonly startNano: bigint;
  readonly endNano: bigint;
}

const statusMessage = (input: RootSpanInput) => {
  if (input.errorMessage !== undefined) return input.errorMessage;

  return input.status === undefined ? "" : `HTTP ${input.status}`;
};

/** OTLP JSON for the Span, through the same encoder Self-Traces use. */
export const rootSpanRequest = (input: RootSpanInput): Uint8Array => {
  const failed = input.outcome !== "ok";

  const span: SelfSpan = {
    traceId: input.context.traceId,
    id: input.context.spanId,
    parentId: null,
    name: SEND_SPAN_NAME,
    kind: "client",
    status: failed ? "error" : "unset",
    statusMessage: failed ? statusMessage(input) : "",
    traceState: "",
    startTimeUnixNano: input.startNano.toString(),
    endTimeUnixNano: input.endNano.toString(),
    attributes: {
      "http.request.method": input.method,
      "url.full": input.url,
      ...(input.status === undefined ? undefined : { "http.response.status_code": input.status }),
      "polaris.send.id": input.sendId,
      "polaris.send.outcome": input.outcome,
    },
    resource: {},
    scope: { name: "polaris.requests", version: "1", attributes: {} },
    events: [],
    links: [],
    droppedAttributes: 0,
    droppedEvents: 0,
    droppedLinks: 0,
  };

  return selfTracesRequest(SEND_SERVICE, [span]);
};
