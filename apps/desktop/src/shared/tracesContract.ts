/** Traces over IPC (ADR 0094): the protocol's payloads plus the Host, and its answers unchanged. */
import {
  GetProfile,
  GetSpan,
  GetTrace,
  type Profile,
  type ProfileDetail,
  type ProfilesSnapshot,
  RestartWithProfiling,
  type SpanDetail,
  type TraceDetail,
  type TracesSnapshot,
  WatchProfiles,
  WatchTraces,
} from "@polaris/protocol";
import { Schema } from "effect";

const OnHost = { hostKey: Schema.String.check(Schema.isMinLength(1)) };

export const TracesRequestInputs = {
  "traces.get": Schema.Struct({ ...OnHost, ...GetTrace.payloadSchema.fields }),
  "traces.span": Schema.Struct({ ...OnHost, ...GetSpan.payloadSchema.fields }),
  "profiles.get": Schema.Struct({ ...OnHost, ...GetProfile.payloadSchema.fields }),
  "profiles.restartWithProfiling": Schema.Struct({
    ...OnHost,
    ...RestartWithProfiling.payloadSchema.fields,
  }),
} as const;

export interface TracesRequestOutputs {
  readonly "traces.get": TraceDetail;
  readonly "traces.span": SpanDetail;
  readonly "profiles.get": ProfileDetail;
  /** The new recording. */
  readonly "profiles.restartWithProfiling": Profile;
}

export const TracesSubscriptionInputs = {
  "traces.watch": Schema.Struct({ ...OnHost, ...WatchTraces.payloadSchema.fields }),
  "profiles.watch": Schema.Struct({ ...OnHost, ...WatchProfiles.payloadSchema.fields }),
} as const;

export interface TracesSubscriptionItems {
  /** Each snapshot replaces the last. */
  readonly "traces.watch": TracesSnapshot;
  /** Each snapshot replaces the last; newest recording first. */
  readonly "profiles.watch": ProfilesSnapshot;
}
