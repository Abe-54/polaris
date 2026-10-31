/** Traces over IPC (ADR 0094): the protocol's payloads plus the Host, and its answers unchanged. */
import {
  CompareTraces,
  GetSpan,
  GetTrace,
  GetWorkspaceTracesSettings,
  SetWorkspaceTracesSettings,
  type SpanDetail,
  type TraceComparison,
  type TraceDetail,
  type TracesSnapshot,
  WatchTraces,
  type WorkspaceTracesSettings,
} from "@polaris/protocol";
import { Schema } from "effect";

const OnHost = { hostKey: Schema.String.check(Schema.isMinLength(1)) };

export const TracesRequestInputs = {
  "traces.get": Schema.Struct({ ...OnHost, ...GetTrace.payloadSchema.fields }),
  "traces.span": Schema.Struct({ ...OnHost, ...GetSpan.payloadSchema.fields }),
  "traces.settings": Schema.Struct({
    ...OnHost,
    ...GetWorkspaceTracesSettings.payloadSchema.fields,
  }),
  "traces.setSettings": Schema.Struct({
    ...OnHost,
    ...SetWorkspaceTracesSettings.payloadSchema.fields,
  }),
  "traces.compare": Schema.Struct({ ...OnHost, ...CompareTraces.payloadSchema.fields }),
} as const;

export interface TracesRequestOutputs {
  readonly "traces.get": TraceDetail;
  readonly "traces.span": SpanDetail;
  /** Workspace policy and detected exporters; header values never cross IPC. */
  readonly "traces.settings": WorkspaceTracesSettings;
  readonly "traces.setSettings": WorkspaceTracesSettings;
  /** Gated on `traces.compare`, apart from the rest of Traces. */
  readonly "traces.compare": TraceComparison;
}

export const TracesSubscriptionInputs = {
  "traces.watch": Schema.Struct({ ...OnHost, ...WatchTraces.payloadSchema.fields }),
} as const;

export interface TracesSubscriptionItems {
  /** Each snapshot replaces the last. */
  readonly "traces.watch": TracesSnapshot;
}
