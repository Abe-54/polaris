import { Effect } from "effect";
import type { WorkspaceTrust } from "../../services.ts";
import type { EventStore } from "../../store/EventStore.ts";
import type { IngestContext } from "../ingest.ts";
import type { TraceEnvironment } from "../runtime.ts";
import type { TraceSettings } from "../settings.ts";

export interface LaunchInstrumentationServices {
  readonly home: string | undefined;
  readonly settings: TraceSettings["Service"] | undefined;
  readonly trust: WorkspaceTrust["Service"] | undefined;
  readonly events: EventStore["Service"] | undefined;
}

/** The caller has resolved active checkout authority and injected the signed receiver endpoint. */
export const launchInstrumentation = Effect.fnUntraced(function* (
  context: IngestContext,
  source: TraceEnvironment,
  services: LaunchInstrumentationServices,
  cwd: string = context.checkout
) {
  const owner = services.settings;

  if (owner === undefined) return {};
  const value = yield* owner.get(context.workspaceId, false);

  if (value.autoInstrument === "off") return {};
  const { trust, events } = services;

  const session =
    context.sessionId !== null && events !== undefined
      ? (yield* events.model).sessions.get(context.sessionId)?.session
      : undefined;

  const readOnly = session?.origin === "reviewer" || session?.permissionMode === "plan";
  const trusted = trust !== undefined && (yield* trust.trusted(context.workspaceId));

  const detectedExporters = value.detectedExporters.filter(
    (exporter) => exporter.kind === "fixed-url"
  );

  if (!trusted || readOnly) {
    yield* owner.recordInstrumentation(context.workspaceId, {
      skipReason: readOnly
        ? "This agent session is read-only."
        : "Trust this workspace before enabling auto-instrumentation.",
      detectedExporters,
    });

    return {};
  }

  const { prepareAutoInstrumentation } = yield* Effect.promise(() => import("./index.ts"));

  const result = yield* Effect.promise(() =>
    prepareAutoInstrumentation({
      checkout: context.checkout,
      cwd: session?.cwd ?? cwd,
      settings: value,
      source,
      home: services.home,
    })
  );

  yield* owner.recordInstrumentation(context.workspaceId, {
    skipReason: result.skipReason,
    detectedExporters,
    overriddenSdk: result.overriddenSdk ?? null,
  });

  return result.environment;
});
