/** Traces over IPC (ADR 0094): the protocol's payloads plus the Host, and its answers unchanged. */
import {
  GetProfile,
  AttachProfile,
  CompareTraces,
  GetSpan,
  GetTrace,
  GetWorkspaceTracesSettings,
  InstallTracingSkill,
  type InstalledTracingSkill,
  SetWorkspaceTracesSettings,
  type Profile,
  type ProfileDetail,
  type ProfilesSnapshot,
  RestartWithProfiling,
  type SpanDetail,
  type TraceComparison,
  type TraceDetail,
  type TracesSnapshot,
  WatchProfiles,
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
  "traces.installSkill": Schema.Struct({ ...OnHost, ...InstallTracingSkill.payloadSchema.fields }),
  "profiles.attach": Schema.Struct({ ...OnHost, ...AttachProfile.payloadSchema.fields }),
  "profiles.get": Schema.Struct({ ...OnHost, ...GetProfile.payloadSchema.fields }),
  "profiles.restartWithProfiling": Schema.Struct({
    ...OnHost,
    ...RestartWithProfiling.payloadSchema.fields,
  }),
  "traces.compare": Schema.Struct({ ...OnHost, ...CompareTraces.payloadSchema.fields }),
} as const;

export interface TracesRequestOutputs {
  readonly "traces.get": TraceDetail;
  readonly "traces.span": SpanDetail;
  /** Workspace policy and detected exporters; header values never cross IPC. */
  readonly "traces.settings": WorkspaceTracesSettings;
  readonly "traces.setSettings": WorkspaceTracesSettings;
  /** The skill folders the Daemon wrote. */
  readonly "traces.installSkill": InstalledTracingSkill;
  readonly "profiles.attach": Profile;
  readonly "profiles.get": ProfileDetail;
  /** The new recording. */
  readonly "profiles.restartWithProfiling": Profile;
  /** Gated on `traces.compare`, apart from the rest of Traces. */
  readonly "traces.compare": TraceComparison;
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
