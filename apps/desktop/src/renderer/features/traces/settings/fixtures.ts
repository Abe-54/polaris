/**
 * Traces settings fixtures (Paper T4): sightline with three Axiom exporters fixed in code, and a
 * fresh Workspace with none. The fixture api applies patches and refuses what the Daemon would.
 */
import {
  TraceForwardTarget,
  type WorkspaceTracesSettings,
  type WorkspaceTracesSettingsUpdate,
} from "@polaris/protocol";
import { Schema } from "effect";
import type { Result } from "../../../../shared/api.ts";
import type { TracesSettingsApi } from "./api.ts";

export const SIGHTLINE_SETTINGS: WorkspaceTracesSettings = {
  enabled: true,
  forwarding: true,
  forwardTo: {
    url: "https://api.axiom.co/v1/traces",
    headerNames: ["authorization", "x-axiom-dataset"],
  },
  detectedExporters: [
    {
      kind: "axiom",
      file: "apps/web/src/instrumentation-node.ts",
      line: 36,
      runtime: "node",
      alreadyExporting: false,
    },
    {
      kind: "axiom",
      file: "apps/bot/src/instrumentation.ts",
      line: 13,
      runtime: "bun",
      alreadyExporting: false,
    },
    {
      kind: "axiom",
      file: "apps/gamedata/src/services/tracing.ts",
      line: 35,
      runtime: "node",
      alreadyExporting: false,
    },
  ],
  autoInstrument: "node",
  autoInstrumentOverride: false,
  autoInstrumentSkipReason:
    "this workspace sets up OpenTelemetry itself (@opentelemetry/sdk-trace-node).",
};

export const FRESH_SETTINGS: WorkspaceTracesSettings = {
  enabled: true,
  forwarding: false,
  forwardTo: null,
  detectedExporters: [],
  autoInstrument: "off",
  autoInstrumentOverride: false,
  autoInstrumentSkipReason: null,
};

const isTarget = Schema.is(TraceForwardTarget);

const invalid = (message: string): Result<never> => ({
  ok: false,
  error: { code: "E-TRACE-SETTINGS-INVALID", message, fix: "Check the collector URL" },
});

const apply = (
  current: WorkspaceTracesSettings,
  patch: WorkspaceTracesSettingsUpdate
): Result<WorkspaceTracesSettings> => {
  if (patch.forwardTo !== undefined && patch.forwardTo !== null && !isTarget(patch.forwardTo))
    return invalid("The forward URL can't carry credentials, a query or a fragment");

  const next = { ...current, ...patch };

  if (next.forwarding && next.forwardTo === null)
    return invalid("Forwarding needs a collector to forward to");

  return { ok: true, value: next };
};

/**
 * Settings per Workspace id; unknown Workspaces get `fallback`. `sent` records each patch, so a test
 * can read what crossed the boundary.
 */
export const fixtureTracesSettingsApi = (
  byWorkspace: Readonly<Record<string, WorkspaceTracesSettings>>,
  fallback: WorkspaceTracesSettings = FRESH_SETTINGS
): TracesSettingsApi & { readonly sent: Array<WorkspaceTracesSettingsUpdate> } => {
  const state = new Map(Object.entries(byWorkspace));
  const sent: Array<WorkspaceTracesSettingsUpdate> = [];

  return {
    sent,
    get: async (_hostKey, workspaceId) => ({
      ok: true,
      value: state.get(workspaceId) ?? fallback,
    }),
    set: async (_hostKey, workspaceId, patch) => {
      sent.push(patch);
      const result = apply(state.get(workspaceId) ?? fallback, patch);

      if (result.ok) state.set(workspaceId, result.value);

      return result;
    },
  };
};
