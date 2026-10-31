/**
 * Settings → Traces and the fixed-exporter card (DESIGN.md, Traces → Setup; Paper T4): which
 * Hosts can answer, which detected exporters have their URL fixed in code, and each row's line.
 */
import {
  type DetectedTraceExporter,
  TRACES_SETTINGS_CAPABILITY,
  TraceForwardUrl,
  type WorkspaceTracesSettings,
} from "@polaris/protocol";
import { Schema } from "effect";
import type { HostView } from "../../../../shared/api.ts";

/** Why a Host can't show its Workspaces' Traces settings, or null when it can. */
export const tracesSettingsUnavailable = (
  host: Pick<HostView, "label" | "status"> | undefined
): string | null => {
  if (host === undefined) return "This host is no longer listed";

  if (host.status.state !== "connected") return `${host.label} isn't connected`;

  return host.status.capabilities.includes(TRACES_SETTINGS_CAPABILITY)
    ? null
    : `Traces settings need a newer daemon on ${host.label}`;
};

/**
 * Exporters the environment can't redirect: a literal collector URL, or Axiom's exporter with
 * its URL in code. `otlp-env` reads the standard variables and `@vercel/otel` adds the env one.
 */
const FIXED_KINDS: ReadonlySet<DetectedTraceExporter["kind"]> = new Set(["fixed-url", "axiom"]);

export const fixedExporters = (
  settings: Pick<WorkspaceTracesSettings, "detectedExporters">
): ReadonlyArray<DetectedTraceExporter> =>
  settings.detectedExporters.filter((e) => FIXED_KINDS.has(e.kind));

export const exporterLocation = (e: Pick<DetectedTraceExporter, "file" | "line">) =>
  `${e.file}:${e.line}`;

const VENDORS: Readonly<Record<DetectedTraceExporter["kind"], string>> = {
  axiom: "Axiom",
  vercel: "@vercel/otel",
  "otlp-env": "OpenTelemetry",
  "fixed-url": "its collector",
};

const targetOf = (exporters: ReadonlyArray<DetectedTraceExporter>) => {
  const kinds = new Set(exporters.map((e) => e.kind));
  const only = kinds.size === 1 ? [...kinds][0] : undefined;

  return only === undefined ? "its collectors" : VENDORS[only];
};

/** "sightline sends its traces straight to Axiom": the card's title. */
export const fixedExporterTitle = (
  workspace: string,
  exporters: ReadonlyArray<DetectedTraceExporter>
) => `${workspace} sends its traces straight to ${targetOf(exporters)}`;

/** Why Polaris can't see them, and what the change keeps; forwarding decides the last clause. */
export const fixedExporterLead = (
  exporters: ReadonlyArray<DetectedTraceExporter>,
  forwarding: boolean
) => {
  const who =
    exporters.length === 1
      ? "An exporter sets its address"
      : `${exporters.length} exporters set their address`;

  const keep = forwarding
    ? `Reading the endpoint from the environment keeps ${targetOf(exporters)} getting everything; Polaris forwards to it.`
    : `Reading the endpoint from the environment sends agents' traces to Polaris instead; turn on forwarding to keep ${targetOf(exporters)} getting them.`;

  return `${who} in code, so Polaris never sees them. ${keep}`;
};

/** The collector's host for the closed field ("api.axiom.co"), or the URL when it won't parse. */
export const forwardHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const isForwardUrl = Schema.is(TraceForwardUrl);

export type ForwardUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

/** A URL the Daemon would take, or why not; credentials stay in the app's headers. */
export const checkForwardUrl = (text: string): ForwardUrlCheck => {
  const url = text.trim();

  if (url === "") return { ok: false, reason: "Enter the collector's URL" };

  return isForwardUrl(url)
    ? { ok: true, url }
    : {
        ok: false,
        reason:
          "Use an http or https URL with no user, password, query or fragment; keys stay in the app's headers",
      };
};

/** The app's header names under the URL; their values never leave the Host. */
export const headersLine = (headers: ReadonlyArray<string>) =>
  headers.length === 0
    ? "No headers from the app"
    : `Headers ${headers.join(" · ")} · values stay on this host`;

/** One line: where the collector came from; the URL row below names the headers. */
export const forwardCaption = (settings: WorkspaceTracesSettings): string => {
  const found = settings.detectedExporters[0];

  if (settings.forwardTo === null)
    return found === undefined
      ? "No exporter found here. Add the collector your app sends to."
      : `Found an exporter in ${found.file}. Add the collector it sends to.`;

  return found === undefined
    ? "A copy of each trace goes on to this collector."
    : `A copy of each trace goes on to the collector found in ${found.file}.`;
};

/** Requested mode beside what actually happens; a skip reason wins. */
export const instrumentCaption = (settings: WorkspaceTracesSettings): string => {
  if (settings.autoInstrumentSkipReason !== null)
    return `Skipped: ${settings.autoInstrumentSkipReason}`;

  switch (settings.autoInstrument) {
    case "off":
      return "Commands agents run here get OpenTelemetry only if the app sets it up. Bun is never instrumented automatically.";
    case "node":
      return "Node commands agents run here get OpenTelemetry without code changes. Bun is never instrumented automatically.";
    case "deno":
      return "Deno commands agents run here export through Deno's built-in OpenTelemetry. Bun is never instrumented automatically.";
  }
};

/** What the receiver keeps per checkout (apps/daemon/src/traces/database.ts, retention.ts). */
export const KEEP_LINE = "200 MB · 7 days · errors always";
