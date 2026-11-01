/** Checkout-scoped Traces and Profiles (ADR 0094). Each RPC documents its required capability. */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Unsupported } from "./errors.ts";
import { SessionId, Timestamp, TurnId, WorkspaceId } from "./ids.ts";

export const TRACES_CAPABILITY = "traces";

/** Lowercase OTLP hex identifiers, without a prefix. */
export const TraceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));

export const SpanId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/));

export const TraceIdPrefix = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8,32}$/));

export const SpanIdPrefix = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8,16}$/));

/** Exact Unix nanoseconds as a decimal string; never round through a JavaScript number. */
export const TraceNanoseconds = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** OTLP status. A summary is `error` if any retained Span has error status. */
export const TraceStatus = Schema.Literals(["unset", "ok", "error"]);

export type TraceStatus = typeof TraceStatus.Type;

/**
 * Redacted OTLP attributes. int64 values are decimal strings; bytes are base64 strings.
 * Attribute keys are retained. Sensitive values are replaced in full by the literal JSON string
 * "[redacted]", never removed or wrapped in an object. This applies to Span, event, link, resource,
 * scope and log attributes, and matching values in log bodies.
 */
export const TraceAttributes = Schema.Record(Schema.String, Schema.Json);

export type TraceAttributes = typeof TraceAttributes.Type;

/** A Turn's stable id and displayed number in its Agent Session. Null attribution means between Turns. */
export const TraceTurn = Schema.Struct({
  sessionId: SessionId,
  id: TurnId,
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export type TraceTurn = typeof TraceTurn.Type;

export const TraceAttribution = Schema.Struct({
  /** Canonical checkout path, resolved by the Daemon from the ingest token. */
  checkout: Schema.String,
  workspaceId: WorkspaceId,
  /** Null for a Polaris terminal belonging to the Workspace. */
  sessionId: Schema.NullOr(SessionId),
  /** Turn active when this Span started, not when the batch arrived. Null means between Turns. */
  turn: Schema.NullOr(TraceTurn),
  /** Turn that launched the exporting process; null for a user terminal or unknown launch. */
  launchedTurn: Schema.NullOr(TraceTurn),
});

export type TraceAttribution = typeof TraceAttribution.Type;

export const TraceScope = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  attributes: TraceAttributes,
});

export const SpanEvent = Schema.Struct({
  name: Schema.String,
  timeUnixNano: TraceNanoseconds,
  attributes: TraceAttributes,
  droppedAttributes: Count,
});

export const SpanLink = Schema.Struct({
  traceId: TraceId,
  spanId: SpanId,
  traceState: Schema.String,
  attributes: TraceAttributes,
  droppedAttributes: Count,
});

/** One timed step. Arrays contain retained records; dropped counts are reported by the exporter. */
export const Span = Schema.Struct({
  traceId: TraceId,
  id: SpanId,
  parentId: Schema.NullOr(SpanId),
  name: Schema.String,
  kind: Schema.Literals(["unspecified", "internal", "server", "client", "producer", "consumer"]),
  service: Schema.String,
  status: TraceStatus,
  statusMessage: Schema.String,
  traceState: Schema.String,
  startTimeUnixNano: TraceNanoseconds,
  endTimeUnixNano: TraceNanoseconds,
  /** Derived milliseconds for display; exact times above remain authoritative. */
  durationMs: Milliseconds,
  attributes: TraceAttributes,
  resource: TraceAttributes,
  scope: TraceScope,
  polaris: TraceAttribution,
  events: Schema.Array(SpanEvent),
  links: Schema.Array(SpanLink),
  droppedAttributes: Count,
  droppedEvents: Count,
  droppedLinks: Count,
});

export type Span = typeof Span.Type;

/** An OTLP log record. Null ids mean the exporter did not correlate it with a Span. */
export const LogRecord = Schema.Struct({
  /** Stable store-assigned id, used to deduplicate records across reads. */
  id: Schema.String,
  traceId: Schema.NullOr(TraceId),
  spanId: Schema.NullOr(SpanId),
  timeUnixNano: TraceNanoseconds,
  observedTimeUnixNano: TraceNanoseconds,
  severityNumber: Count,
  severityText: Schema.String,
  body: Schema.Json,
  attributes: TraceAttributes,
  resource: TraceAttributes,
  scope: TraceScope,
  polaris: TraceAttribution,
  droppedAttributes: Count,
});

export type LogRecord = typeof LogRecord.Type;

/** One operation in a checkout. Counts and duration describe retained Spans, including partial traces. */
export const TraceSummary = Schema.Struct({
  id: TraceId,
  /** Root name and id; earliest retained Span when the exporter has not sent a root. */
  root: Schema.String,
  rootSpanId: SpanId,
  service: Schema.String,
  startedAt: Timestamp,
  startTimeUnixNano: TraceNanoseconds,
  durationMs: Milliseconds,
  spans: Count,
  /** Unique service names in alphabetical order. */
  services: Schema.Array(Schema.String),
  errors: Count,
  status: TraceStatus,
  /** Attribution of the root (or earliest retained Span). */
  turn: Schema.NullOr(TraceTurn),
  sessionId: Schema.NullOr(SessionId),
  /** Explicit retention link, distinct from automatic Turn attribution. */
  linked: Schema.Boolean,
  /** True if known Spans were removed by retention. Missing upstream parents alone do not set this. */
  partial: Schema.Boolean,
});

export type TraceSummary = typeof TraceSummary.Type;

export const TraceDetail = Schema.Struct({
  summary: TraceSummary,
  /** All retained Spans, in start-time order with id as the tie-breaker. */
  spans: Schema.Array(Span),
  /** Earlier retained observations in this checkout, matched by Span name and parent name. */
  usual: Schema.optional(
    Schema.Record(
      SpanId,
      Schema.Struct({
        usualMs: Milliseconds,
        samples: Count,
      })
    )
  ),
});

export type TraceDetail = typeof TraceDetail.Type;

export const SpanDetail = Schema.Struct({
  span: Span,
  /** At most 20 matching records, newest first. */
  logs: Schema.Array(LogRecord).check(Schema.isMaxLength(20)),
  /** Total matching retained log records, before the 20-record limit. */
  logCount: Count,
});

export type SpanDetail = typeof SpanDetail.Type;

export const TraceAvailability = Schema.TaggedUnion({
  Listening: {},
  Unavailable: { code: Schema.String, message: Schema.String, owner: Schema.NullOr(Schema.String) },
});

export type TraceAvailability = typeof TraceAvailability.Type;

/** Snapshot replaces the previous one. A watch emits immediately, then only after changes. */
export const TracesSnapshot = Schema.Struct({
  availability: TraceAvailability,
  /** True when the user's exporter endpoint prevented injection for this Agent Session. */
  userExported: Schema.Boolean,
  /** Token-bearing URL on the first watch page only; null on later pages or when disabled. Never persist it. */
  endpoint: Schema.NullOr(Schema.String),
  traces: Schema.Array(TraceSummary),
  /** Number matching the filters before the limit. */
  total: Count,
});

export type TracesSnapshot = typeof TracesSnapshot.Type;

/** Omitted turn means all Turns. Null selects between Turns; an id selects that exact Turn. */
export const TraceFilter = Schema.Struct({
  turn: Schema.optionalKey(Schema.NullOr(TurnId)),
  /** Glob against the root name; only * and ? are special. */
  route: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  service: Schema.optionalKey(Schema.String),
  /** `ok` includes unset status; `error` means at least one error Span. */
  status: Schema.optionalKey(Schema.Literals(["ok", "error"])),
  minMs: Schema.optionalKey(Milliseconds),
  /** Defaults to 50; newest start time first, trace id breaks ties. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});

export type TraceFilter = typeof TraceFilter.Type;

export class TraceError extends Schema.TaggedError<TraceError>()("TraceError", {
  code: Schema.Literals([
    "E-INPUT",
    "E-TRACE-NOT-FOUND",
    "E-TRACE-AMBIGUOUS",
    "E-TRACE-NONE",
    "E-TRACE-UNAVAILABLE",
  ]),
  message: Schema.String,
  fix: Schema.String,
}) {}

const Errors = Schema.Union([TraceError, Unsupported]);

/** All reads resolve sessionId to its checkout on the Daemon; callers never supply a checkout path. */
export const WatchTraces = Rpc.make("traces.watch", {
  payload: { sessionId: SessionId, filter: Schema.optionalKey(TraceFilter) },
  success: TracesSnapshot,
  error: Errors,
  stream: true,
});

export const GetTrace = Rpc.make("traces.get", {
  payload: { sessionId: SessionId, traceId: TraceIdPrefix },
  success: TraceDetail,
  error: Errors,
});

export const GetSpan = Rpc.make("traces.span", {
  payload: { sessionId: SessionId, traceId: TraceIdPrefix, spanId: SpanIdPrefix },
  success: SpanDetail,
  error: Errors,
});

export const TRACES_SETTINGS_CAPABILITY = "traces.settings";

export const TRACES_PROFILES_CAPABILITY = "traces.profiles";

export const TRACES_COMPARE_CAPABILITY = "traces.compare";

/** Public collector address; credentials, query strings and fragments stay on the Host. */
export const TraceForwardUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  })
);

/** Header names are HTTP tokens, never `name: value` pairs. Values never enter this protocol. */
export const TraceForwardTarget = Schema.Struct({
  url: TraceForwardUrl,
  headerNames: Schema.Array(Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/))),
  /** Read-only metadata; absent on older Daemons. True only for the app's launch origin. */
  passesAppHeaders: Schema.optionalKey(Schema.Boolean),
});

export type TraceForwardTarget = typeof TraceForwardTarget.Type;

/** Exporter evidence uses checkout-relative paths and one-based lines; no source text or secrets. */
export const DetectedTraceExporter = Schema.Struct({
  kind: Schema.Literals(["axiom", "vercel", "otlp-env", "fixed-url"]),
  file: Schema.String,
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  runtime: Schema.NullOr(Schema.Literals(["node", "bun", "deno"])),
  /** True when the app already sends a second copy to its collector; forwarding must skip it. */
  alreadyExporting: Schema.Boolean,
});

export type DetectedTraceExporter = typeof DetectedTraceExporter.Type;

/** Requested instrumentation. Bun is never auto-instrumented, including under manual override. */
export const TraceAutoInstrument = Schema.Literals(["off", "node", "deno"]);

export type TraceAutoInstrument = typeof TraceAutoInstrument.Type;

/** Workspace policy plus current detection. Secrets and header values are never returned. */
export const WorkspaceTracesSettings = Schema.Struct({
  /** Copy incoming Traces into Polaris for this Workspace. Independent of forwarding. */
  enabled: Schema.Boolean,
  forwarding: Schema.Boolean,
  forwardTo: Schema.NullOr(TraceForwardTarget),
  detectedExporters: Schema.Array(DetectedTraceExporter),
  autoInstrument: TraceAutoInstrument,
  /** Explicitly bypass SDK detection for Node; does not bypass runtime or Workspace Trust checks. */
  autoInstrumentOverride: Schema.Boolean,
  /** Null when instrumentation is not skipped; explains SDK detection or runtime restrictions. */
  autoInstrumentSkipReason: Schema.NullOr(Schema.String),
});

export type WorkspaceTracesSettings = typeof WorkspaceTracesSettings.Type;

/** Omitted fields stay unchanged; null forwardTo clears the target. Detection is read-only. */
export const WorkspaceTracesSettingsUpdate = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  forwarding: Schema.optionalKey(Schema.Boolean),
  forwardTo: Schema.optionalKey(Schema.NullOr(TraceForwardTarget)),
  autoInstrument: Schema.optionalKey(TraceAutoInstrument),
  autoInstrumentOverride: Schema.optionalKey(Schema.Boolean),
});

export type WorkspaceTracesSettingsUpdate = typeof WorkspaceTracesSettingsUpdate.Type;

export class TraceSettingsError extends Schema.TaggedError<TraceSettingsError>()(
  "TraceSettingsError",
  {
    code: Schema.Literals(["E-TRACE-SETTINGS-INVALID", "E-TRACE-SETTINGS-UNAVAILABLE"]),
    message: Schema.String,
    fix: Schema.String,
  }
) {}

/** Capability `traces.settings`; the Daemon resolves the registered Workspace, never a caller path. */
export const GetWorkspaceTracesSettings = Rpc.make("traces.settings", {
  payload: { workspaceId: WorkspaceId },
  success: WorkspaceTracesSettings,
  error: Schema.Union([TraceSettingsError, Unsupported]),
});

/** Returns the complete settings after applying the patch. No credential-setting RPC is provided. */
export const SetWorkspaceTracesSettings = Rpc.make("traces.setSettings", {
  payload: { workspaceId: WorkspaceId, settings: WorkspaceTracesSettingsUpdate },
  success: WorkspaceTracesSettings,
  error: Schema.Union([TraceSettingsError, Unsupported]),
});

/** Store-assigned id, scoped to the checkout resolved from the caller's Agent Session. */
export const ProfileId = Schema.String.pipe(Schema.brand("ProfileId"));

export type ProfileId = typeof ProfileId.Type;

/** One CPU recording of a process Polaris launched. Times are milliseconds, startedAt is UTC. */
export const Profile = Schema.Struct({
  /** Verified execution directory; may be a package subfolder. Never a restart authority. */
  cwd: Schema.optionalKey(Schema.String),
  id: ProfileId,
  command: Schema.String,
  runtime: Schema.Literals(["node", "bun"]),
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Turn that launched the recording; null when no Turn owns it. */
  turn: Schema.NullOr(TraceTurn),
  startedAt: Timestamp,
  durationMs: Milliseconds,
  /** Absolute .cpuprofile path on the Host; null until an artifact exists. Never a read authority. */
  path: Schema.NullOr(Schema.String),
  status: Schema.Literals(["recording", "completed", "failed"]),
  /**
   * How the recording was made: `command` profiled a whole command, `restart` restarted a process
   * with profiling, `attach` profiled a running process. Omitted by Daemons that predate it.
   */
  origin: Schema.optionalKey(Schema.Literals(["command", "restart", "attach"])),
  /** The profiled process's `service.name`, when known. Omitted by Daemons that predate it. */
  service: Schema.optionalKey(Schema.String),
});

export type Profile = typeof Profile.Type;

/** Aggregated CPU time for a function. Null file/line denotes a native or unresolved frame. */
export const ProfileFunction = Schema.Struct({
  name: Schema.String,
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  selfMs: Milliseconds,
  totalMs: Milliseconds,
});

export type ProfileFunction = typeof ProfileFunction.Type;

/** One chronological flame chart frame; indices are zero-based, offsets relative to startedAt. */
export const ProfileNode = Schema.Struct({
  /** Index of an earlier node, or null for a root. Parents precede children. */
  parent: Schema.NullOr(Count),
  /** Index in ProfileDetail.hotFunctions. A function can appear in many frames. */
  functionIndex: Count,
  startMs: Milliseconds,
  durationMs: Milliseconds,
});

export type ProfileNode = typeof ProfileNode.Type;

/** Parsed recording, with both self and inclusive time, ready for text and flame chart consumers. */
export const ProfileDetail = Schema.Struct({
  profile: Profile,
  /** All functions, descending totalMs then selfMs; a selfMs-sorted view must preserve original indices. */
  hotFunctions: Schema.Array(ProfileFunction),
  /** Root-to-leaf hottest stack as indices into hotFunctions. */
  hotPath: Schema.Array(Count),
  nodes: Schema.Array(ProfileNode),
});

export type ProfileDetail = typeof ProfileDetail.Type;

/** A watch emits immediately, then replaces the list on changes; newest startedAt first, id breaks ties. */
export const ProfilesSnapshot = Schema.Struct({ profiles: Schema.Array(Profile) });

export type ProfilesSnapshot = typeof ProfilesSnapshot.Type;

export class ProfileError extends Schema.TaggedError<ProfileError>()("ProfileError", {
  code: Schema.Literals([
    "E-PROFILE-NOT-FOUND",
    "E-PROFILE-INVALID",
    "E-PROFILE-UNAVAILABLE",
    "E-PROFILE-PROCESS-NOT-OWNED",
    "E-PROFILE-RESTART-REFUSED",
    "E-PROFILE-ATTACH-REFUSED",
    "E-PROFILE-ATTACH-DENIED",
  ]),
  message: Schema.String,
  fix: Schema.String,
}) {}

const ProfileErrors = Schema.Union([ProfileError, Unsupported]);

/** Capability `traces.profiles`; every operation resolves sessionId to its checkout on the Daemon. */
export const WatchProfiles = Rpc.make("profiles.watch", {
  payload: { sessionId: SessionId },
  success: ProfilesSnapshot,
  error: ProfileErrors,
  stream: true,
});

export const GetProfile = Rpc.make("profiles.get", {
  payload: { sessionId: SessionId, profileId: ProfileId },
  success: ProfileDetail,
  error: ProfileErrors,
});

/**
 * Restarts only a process whose launch Polaris owns in this checkout, after revalidating its identity.
 * Never attaches an inspector or takes ownership of a user-started process from its pid alone.
 */
export const RestartWithProfiling = Rpc.make("profiles.restartWithProfiling", {
  payload: { sessionId: SessionId, pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) },
  success: Profile,
  error: ProfileErrors,
});

/** User-initiated cooperative Node capture. The click is consent; requires the approve Grant. */
export const AttachProfile = Rpc.make("profiles.attach", {
  payload: {
    sessionId: SessionId,
    pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
  },
  success: Profile,
  error: ProfileErrors,
});

/**
 * Tagged selectors distinguish Turn ids and hex Trace ids; Baseline is only valid before a Turn.
 * Turns selects every Turn from `firstTurnId` through `lastTurnId` in the session, in order
 * (one user Turn and its continuations); it pairs wherever Turn does.
 */
export const TraceCompareSelector = Schema.TaggedUnion({
  Baseline: {},
  Turn: { turnId: TurnId },
  Turns: { firstTurnId: TurnId, lastTurnId: TurnId },
  Trace: { traceId: TraceIdPrefix },
});

export type TraceCompareSelector = typeof TraceCompareSelector.Type;

/** Retained root durations, nearest-rank percentiles; fewer than three on either side gives null times. */
export const TraceRouteStats = Schema.Struct({
  p50Ms: Schema.NullOr(Milliseconds),
  p95Ms: Schema.NullOr(Milliseconds),
  count: Count,
});

export type TraceRouteStats = typeof TraceRouteStats.Type;

/** Union of service/root-name pairs on either side; missing sides have empty stats, never a baseline guess. */
export const TraceComparison = Schema.Struct({
  a: TraceCompareSelector,
  b: TraceCompareSelector,
  /** Alphabetical service then route order. Baseline is valid only as a, against a Turn b. */
  routes: Schema.Array(
    Schema.Struct({
      service: Schema.String,
      route: Schema.String,
      before: TraceRouteStats,
      after: TraceRouteStats,
      /** Longest after Span with a new service/name/parent-name signature within this route. */
      slowestNew: Schema.optionalKey(
        Schema.Struct({
          name: Schema.String,
          service: Schema.String,
          durationMs: Milliseconds,
          traceId: TraceId,
          spanId: SpanId,
        })
      ),
      /** Partial traces are excluded from counts, percentiles and new-span detection. */
      partial: Schema.optionalKey(Schema.Struct({ before: Count, after: Count })),
    })
  ),
});

export type TraceComparison = typeof TraceComparison.Type;

/** Capability `traces.compare`; a Turn (or Turns) selects its attributed Traces, a Trace one exact/prefix match. */
export const CompareTraces = Rpc.make("traces.compare", {
  payload: { sessionId: SessionId, a: TraceCompareSelector, b: TraceCompareSelector },
  success: TraceComparison,
  error: Errors,
});

export class TracesSettingsRpcs extends RpcGroup.make(
  GetWorkspaceTracesSettings,
  SetWorkspaceTracesSettings
) {}

export class ProfilesRpcs extends RpcGroup.make(
  WatchProfiles,
  GetProfile,
  RestartWithProfiling,
  AttachProfile
) {}

export class TraceCompareRpcs extends RpcGroup.make(CompareTraces) {}

export class TracesRpcs extends RpcGroup.make(WatchTraces, GetTrace, GetSpan) {}
