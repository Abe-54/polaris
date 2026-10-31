/**
 * What "Set up tracing" and "Ask an agent to make this change" send (DESIGN.md, Traces → Setup;
 * Paper T4): the polaris-tracing install command, the prompts, and where the agent works.
 */
import type { AgentSession, DetectedTraceExporter, SessionPlacement } from "@polaris/protocol";
import { Placement } from "../../../commands.ts";
import { exporterLocation } from "../settings/model.ts";
import { FIXED_EXPORTER_CHANGE } from "./setup.ts";

/** The P7 install, global so the user's repository gains no files (skills/polaris-tracing). */
export const INSTALL_COMMAND =
  "npx skills add luxdotdev/polaris --skill polaris-tracing -a claude-code codex -y -g";

export const SETUP_PROMPT = [
  "Use the polaris-tracing skill to set up OpenTelemetry tracing in this checkout,",
  "so the server spans, errors and logs of code run here reach Polaris.",
  "Follow the skill to the end: check with the traces tool that a trace arrived,",
  "and say which branch of the skill you took.",
].join(" ");

const runtimeOf = (e: DetectedTraceExporter) => (e.runtime === null ? "" : ` (${e.runtime})`);

/** The fixed-exporter change for these exporters, as one agent task. */
export const fixedExporterPrompt = (exporters: ReadonlyArray<DetectedTraceExporter>): string =>
  [
    "These OpenTelemetry exporters set their collector URL in code, so traces from commands run in Polaris never reach it:",
    ...exporters.map((e) => `- ${exporterLocation(e)}${runtimeOf(e)}`),
    "",
    "In each, change only the URL to read the endpoint from the environment and keep today's URL as the fallback, as the polaris-tracing skill's fixed-exporter line does:",
    FIXED_EXPORTER_CHANGE,
    "Keep the headers and keys as they are. Then run the app and check with the traces tool that a trace arrived.",
  ].join("\n");

/** A new agent session works in the same checkout as the one Traces shows. */
export const placementOf = (session: Pick<AgentSession, "cwd" | "worktreeId">): SessionPlacement =>
  session.worktreeId === null
    ? Placement.InPlace()
    : Placement.ExistingWorktree({ path: session.cwd });

/**
 * How a task reaches the agent: a Working session takes it as a steer, an Idle or Dormant one as
 * its next Turn; any other (needs you, failed, archived…) leaves it to a new agent session.
 */
export const askRoute = (state: AgentSession["state"] | null): "steer" | "send" | "start" => {
  if (state === "working") return "steer";

  return state === "idle" || state === "dormant" ? "send" : "start";
};
