import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
  TraceSettingsError,
  WorkspaceTracesSettings,
  WorkspaceTracesSettingsUpdate,
  type DetectedTraceExporter,
  type WorkspaceId,
} from "@polaris/protocol";
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

type Binding = Pick<IngestContext, "workspaceId" | "checkout" | "sessionId">;

const key = (context: Binding) =>
  JSON.stringify([context.workspaceId, context.checkout, context.sessionId]);

export interface TracePolicy {
  readonly generation: number;
  readonly enabled: boolean;
  readonly forwarding: boolean;
  readonly collector: Collector | null;
  readonly alreadyExporting: boolean;
}

export class TraceSettings extends Context.Service<
  TraceSettings,
  {
    readonly get: (id: WorkspaceId) => Effect.Effect<WorkspaceTracesSettings, TraceSettingsError>;
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
      result: { skipReason: string | null; detectedExporters: ReadonlyArray<DetectedTraceExporter> }
    ) => Effect.Effect<void>;
  }
>()("polaris/traces/Settings") {
  static layerAt = (
    filename: string | null,
    resolve: (id: WorkspaceId) => Effect.Effect<string, TraceSettingsError>
  ) =>
    Layer.sync(TraceSettings, () => {
      let saved: typeof SavedSettings.Type | null = null;
      const launches = new Map<string, ExporterDetection>();
      const latest = new Map<WorkspaceId, ExporterDetection>();

      const instrumentation = new Map<
        WorkspaceId,
        { skipReason: string | null; detectedExporters: ReadonlyArray<DetectedTraceExporter> }
      >();

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
            (target === null ? null : detection.suggestedCollector),
          alreadyExporting: detection.detectedExporters.some((e) => e.alreadyExporting),
        };
      };

      const view = (id: WorkspaceId, detection: ExporterDetection) => {
        const value = load()[id] ?? {};
        const extra = instrumentation.get(id);

        return WorkspaceTracesSettings.make({
          ...defaults,
          ...value,
          forwardTo: publicCollector(policy(id, detection).collector),
          detectedExporters: [...detection.detectedExporters, ...(extra?.detectedExporters ?? [])],
          autoInstrumentSkipReason: extra?.skipReason ?? null,
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
                suggestedCollector: previous.suggestedCollector,
              }
            : detected;

        return yield* Effect.try({
          try: () => {
            if (launches.size >= 1024) launches.delete(launches.keys().next().value!);
            launches.set(key(context), detection);
            latest.set(context.workspaceId, detection);

            return policy(context.workspaceId, detection);
          },
          catch: unavailable,
        });
      });

      const get = Effect.fnUntraced(function* (id: WorkspaceId) {
        const checkout = yield* resolve(id);
        const detection = latest.get(id) ?? (yield* detect(checkout, process.env));

        return yield* Effect.try({ try: () => view(id, detection), catch: unavailable });
      });

      return TraceSettings.of({
        get,
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
            instrumentation.set(id, result);
          }),
      });
    });

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
