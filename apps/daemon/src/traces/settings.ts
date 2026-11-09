import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Schema, Option } from "effect";
import {
  TraceSettingsError,
  WorkspaceTracesSettings,
  WorkspaceTracesSettingsUpdate,
  type DetectedTraceExporter,
  type WorkspaceId,
} from "@polaris/protocol";
import { realpath } from "node:fs/promises";
import { TraceSessions } from "./sessions.ts";
import { TraceStore } from "./store.ts";
import { EventStore } from "../store/EventStore.ts";
import { polarisHome } from "../paths.ts";
import {
  collectorFromEnvironment,
  detectExporters,
  isPolarisEndpoint,
  publicCollector,
  type Collector,
  type ExporterDetection,
} from "./detection.ts";
import type { TraceEnvironment } from "./runtime.ts";
import type { IngestContext } from "./ingest.ts";

const SavedSettings = Schema.Record(Schema.String, WorkspaceTracesSettingsUpdate);

const decodeSaved = Schema.decodeUnknownSync(Schema.fromJsonString(SavedSettings));

const unavailable = () =>
  new TraceSettingsError({
    code: "E-TRACE-SETTINGS-UNAVAILABLE",
    message: "Workspace trace settings are unavailable.",
    fix: "Select a registered workspace and check access to the daemon's home.",
  });

const invalid = () =>
  new TraceSettingsError({
    code: "E-TRACE-SETTINGS-INVALID",
    message: "The trace forward target is invalid.",
    fix: "Choose an HTTP collector endpoint outside Polaris.",
  });

const defaults = WorkspaceTracesSettings.make({
  enabled: true,
  forwarding: true,
  forwardTo: null,
  detectedExporters: [],
  autoInstrument: "off",
  autoInstrumentOverride: false,
  autoInstrumentSkipReason: null,
});

interface InstrumentationEvidence {
  readonly skipReason: string | null;
  readonly detectedExporters: ReadonlyArray<DetectedTraceExporter>;
  /** Set when the override instrumented an app that has its own SDK. */
  readonly overriddenSdk?: string | null;
  /** The app ran and no spans have arrived for its checkout. */
  readonly silent?: boolean;
}

// ENG-703: an app's own HttpInstrumentation unwraps Polaris's, so Traces can stay empty.
const silentOverride = (sdk: string) =>
  `No spans arrived with the override on: instrumentations loaded by the app's ${sdk} (such as getNodeAutoInstrumentations) replace Polaris's.`;

const skipReason = (evidence: InstrumentationEvidence | undefined) => {
  if (evidence === undefined) return null;

  if (evidence.skipReason !== null || !evidence.silent || !evidence.overriddenSdk)
    return evidence.skipReason;

  return silentOverride(evidence.overriddenSdk);
};

type Binding = Pick<IngestContext, "workspaceId" | "checkout" | "sessionId">;

const key = (context: Binding) =>
  JSON.stringify([context.workspaceId, context.checkout, context.sessionId]);

export interface TracePolicy {
  readonly generation: number;
  readonly enabled: boolean;
  readonly forwarding: boolean;
  readonly collector: Collector | null;
  readonly launchCollector: Collector | null;
  readonly launchHeaderNames: ReadonlyArray<string>;
  readonly alreadyExporting: boolean;
}

export class TraceSettings extends Context.Service<
  TraceSettings,
  {
    readonly recordLaunch: (context: Binding) => Effect.Effect<void>;
    readonly get: (
      id: WorkspaceId,
      refreshDetection?: boolean
    ) => Effect.Effect<WorkspaceTracesSettings, TraceSettingsError>;
    readonly patch: (
      id: WorkspaceId,
      patch: WorkspaceTracesSettingsUpdate
    ) => Effect.Effect<WorkspaceTracesSettings, TraceSettingsError>;
    readonly prepare: (
      context: Binding,
      source: TraceEnvironment
    ) => Effect.Effect<TracePolicy, TraceSettingsError>;
    readonly policy: (context: Binding) => Effect.Effect<TracePolicy, TraceSettingsError>;
    readonly current: (id: WorkspaceId, generation: number) => boolean;
    readonly subscribe: (listener: (id: WorkspaceId) => void) => () => void;
    readonly recordInstrumentation: (
      id: WorkspaceId,
      result: InstrumentationEvidence
    ) => Effect.Effect<void>;
  }
>()("polaris/traces/Settings") {
  static layerAt = (
    filename: string | null,
    resolve: (id: WorkspaceId) => Effect.Effect<string, TraceSettingsError>
  ) =>
    Layer.effect(
      TraceSettings,
      Effect.gen(function* () {
        const events = yield* Effect.serviceOption(EventStore);
        const traces = yield* Effect.serviceOption(TraceStore);
        const sessions = yield* Effect.serviceOption(TraceSessions);
        const latestCheckout = new Map<WorkspaceId, string>();
        const applications = new Set<string>();
        let saved: typeof SavedSettings.Type | null = null;
        const launches = new Map<string, ExporterDetection>();
        const latest = new Map<WorkspaceId, ExporterDetection>();

        const instrumentation = new Map<WorkspaceId, InstrumentationEvidence>();

        const rememberInstrumentation = (id: WorkspaceId, result: InstrumentationEvidence) => {
          if (instrumentation.size >= 256 && !instrumentation.has(id))
            instrumentation.delete(instrumentation.keys().next().value!);
          instrumentation.set(id, result);
        };

        const generations = new Map<WorkspaceId, number>();
        const listeners = new Set<(id: WorkspaceId) => void>();

        const load = () => {
          saved ??=
            filename !== null && existsSync(filename)
              ? decodeSaved(readFileSync(filename, "utf8"))
              : {};

          return saved;
        };

        const policy = (id: WorkspaceId, detection: ExporterDetection): TracePolicy => {
          const value = load()[id] ?? {};
          const target = value.forwardTo;

          const fallback =
            target == null
              ? null
              : collectorFromEnvironment({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: target.url });

          return {
            generation: generations.get(id) ?? 0,
            enabled: value.enabled ?? true,
            forwarding: value.forwarding ?? true,
            collector:
              detection.collector ??
              fallback ??
              (target === null ? null : detection.launchVendorCollector),
            launchCollector: detection.collector ?? detection.launchVendorCollector,
            launchHeaderNames: detection.launchHeaderNames,
            alreadyExporting: detection.detectedExporters.some((e) => e.alreadyExporting),
          };
        };

        const view = (id: WorkspaceId, detection: ExporterDetection) => {
          const value = load()[id] ?? {};
          const extra = instrumentation.get(id);
          const effective = policy(id, detection);

          return WorkspaceTracesSettings.make({
            ...defaults,
            ...value,
            forwardTo: publicCollector(
              effective.collector,
              effective.launchCollector,
              effective.launchHeaderNames
            ),
            detectedExporters: [
              ...detection.detectedExporters,
              ...(extra?.detectedExporters ?? []),
            ],
            autoInstrumentSkipReason:
              (value.autoInstrument ?? "off") === "off" ? null : skipReason(extra),
          });
        };

        const detect = (checkout: string, source: TraceEnvironment) =>
          Effect.tryPromise({
            try: () => detectExporters(checkout, source),
            catch: unavailable,
          });

        const prepare = Effect.fnUntraced(function* (context: Binding, source: TraceEnvironment) {
          const detected = yield* detect(context.checkout, source);
          const previous = launches.get(key(context));

          const injected =
            isPolarisEndpoint(source.OTEL_EXPORTER_OTLP_ENDPOINT) ||
            isPolarisEndpoint(source.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);

          const detection =
            injected && collectorFromEnvironment(source) === null && previous !== undefined
              ? {
                  ...detected,
                  collector: previous.collector,
                  launchVendorCollector: previous.launchVendorCollector,
                  launchHeaderNames: previous.launchHeaderNames,
                  suggestedCollector: previous.suggestedCollector,
                }
              : detected;

          return yield* Effect.try({
            try: () => {
              if (launches.size >= 1024) launches.delete(launches.keys().next().value!);
              launches.set(key(context), detection);
              latest.set(context.workspaceId, detection);

              if (latestCheckout.size >= 256)
                latestCheckout.delete(latestCheckout.keys().next().value!);
              latestCheckout.set(context.workspaceId, context.checkout);

              return policy(context.workspaceId, detection);
            },
            catch: unavailable,
          });
        });

        const get = Effect.fnUntraced(function* (id: WorkspaceId, refreshDetection = true) {
          const registered = yield* resolve(id);
          const known = latest.get(id);

          if (!refreshDetection && known !== undefined)
            return yield* Effect.try({ try: () => view(id, known), catch: unavailable });
          const root = yield* Effect.promise(() => realpath(registered).catch(() => registered));
          const candidate = latestCheckout.get(id);

          const available =
            candidate !== undefined &&
            Option.isSome(sessions) &&
            (yield* sessions.value.workspaceActive(id, candidate));

          const checkout = available ? candidate : root;
          const detection = latest.get(id) ?? (yield* detect(checkout, process.env));
          let appRan = applications.has(JSON.stringify([id, checkout]));

          if (refreshDetection && !appRan && Option.isSome(events)) {
            const { observedApplication } = yield* Effect.promise(
              () => import("./instrumentation/observation.ts")
            );

            appRan = yield* observedApplication(events.value, id, checkout).pipe(
              Effect.orElseSucceed(() => false)
            );
          }

          const previous = instrumentation.get(id);

          if (refreshDetection && !appRan && previous !== undefined)
            rememberInstrumentation(id, { ...previous, detectedExporters: [], silent: false });

          if (refreshDetection && appRan && Option.isSome(traces)) {
            const page = yield* traces.value.list(checkout).pipe(Effect.orElseSucceed(() => null));

            if (page !== null) {
              const { detectFixedExporters } = yield* Effect.promise(
                () => import("./instrumentation/detection.ts")
              );

              const detectedExporters = yield* Effect.promise(() =>
                detectFixedExporters({ checkout, appRan, spansArrived: page.total > 0 })
              );

              rememberInstrumentation(id, {
                skipReason: previous?.skipReason ?? null,
                overriddenSdk: previous?.overriddenSdk ?? null,
                detectedExporters,
                silent: page.total === 0,
              });
            }
          }

          return yield* Effect.try({ try: () => view(id, detection), catch: unavailable });
        });

        return TraceSettings.of({
          get,
          recordLaunch: (context) =>
            Effect.sync(() => {
              if (applications.size >= 256)
                applications.delete(applications.values().next().value!);
              applications.add(JSON.stringify([context.workspaceId, context.checkout]));

              if (latestCheckout.size >= 256)
                latestCheckout.delete(latestCheckout.keys().next().value!);
              latestCheckout.set(context.workspaceId, context.checkout);
            }),
          prepare,
          current: (id, generation) => (generations.get(id) ?? 0) === generation,
          policy: Effect.fnUntraced(function* (context) {
            const detection = launches.get(key(context));

            if (detection === undefined) return yield* prepare(context, process.env);

            return yield* Effect.try({
              try: () => policy(context.workspaceId, detection),
              catch: unavailable,
            });
          }),
          patch: Effect.fnUntraced(function* (id, patch) {
            const checkout = yield* resolve(id);
            const detection = latest.get(id) ?? (yield* detect(checkout, process.env));

            const update = yield* Effect.try({
              try: () => Schema.decodeUnknownSync(WorkspaceTracesSettingsUpdate)(patch),
              catch: invalid,
            });

            if (isPolarisEndpoint(update.forwardTo?.url)) return yield* invalid();

            return yield* Effect.try({
              try: () => {
                const next = { ...load(), [id]: { ...load()[id], ...update } };

                if (filename !== null) {
                  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
                  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
                  writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
                  renameSync(temporary, filename);
                }

                saved = next;
                generations.set(id, (generations.get(id) ?? 0) + 1);

                if (update.forwarding === false || update.forwardTo !== undefined)
                  for (const listener of listeners) listener(id);

                return view(id, detection);
              },
              catch: unavailable,
            });
          }),
          subscribe: (listener) => {
            listeners.add(listener);

            return () => {
              listeners.delete(listener);
            };
          },
          recordInstrumentation: (id, result) =>
            Effect.sync(() => {
              rememberInstrumentation(id, result);
            }),
        });
      })
    );

  static layerFromStoreAt = (filename: string) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const store = yield* EventStore;

        return TraceSettings.layerAt(filename, (id) =>
          Effect.flatMap(store.model, (model) => {
            const workspace = model.workspaces.get(id);

            return workspace === undefined
              ? Effect.fail(unavailable())
              : Effect.succeed(workspace.path);
          })
        );
      })
    );

  static readonly layer = Layer.suspend(() =>
    TraceSettings.layerFromStoreAt(join(polarisHome(), "trace-settings.json"))
  );
}
