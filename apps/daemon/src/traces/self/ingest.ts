/** Self-Spans enter the store through the receiver's own ingest path, under the Self-Trace scope. */
import { type SelfSpan, WorkspaceId } from "@polaris/protocol";
import { Schema } from "effect";
import type { TraceStore } from "../storeService.ts";
import { selfTracesRequest } from "./otlp.ts";
import { SELF_CHECKOUT } from "./scope.ts";

/** Attribution when no Workspace holds Polaris's code; the scope, not this id, owns the Spans. */
export const SELF_WORKSPACE = Schema.decodeSync(WorkspaceId)(SELF_CHECKOUT);

/** Spans that end before they start are dropped here rather than failing the whole batch. */
export const wellFormed = (spans: ReadonlyArray<SelfSpan>) =>
  spans.filter((span) => BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));

export const ingestSelfSpans = (
  store: TraceStore["Service"],
  options: {
    readonly service: string;
    readonly spans: ReadonlyArray<SelfSpan>;
    readonly workspaceId: WorkspaceId | null;
  }
) =>
  store.ingest({
    bytes: selfTracesRequest(options.service, options.spans),
    signal: "traces",
    contentType: "application/json",
    context: {
      checkout: SELF_CHECKOUT,
      workspaceId: options.workspaceId ?? SELF_WORKSPACE,
      sessionId: null,
      turns: [],
    },
  });
