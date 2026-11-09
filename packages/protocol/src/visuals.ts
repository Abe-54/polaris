/**
 * The Visuals setting (ENG-597, ADR 0101): how readily agents reach for the `visualize` tool on
 * the Polaris MCP. `off` removes the tool and its guidance. One setting for every Host: the
 * Desktop App keeps it and writes it to each with `sessions.setVisuals`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Unsupported } from "./errors.ts";
import { FileError } from "./files.ts";

/** The same literals as `@polaris/visualization`'s `VisualsLevel`. */
export const VisualsLevel = Schema.Literals(["rich", "simple", "off"]);

export type VisualsLevel = typeof VisualsLevel.Type;

export class VisualsSettings extends Schema.Class<VisualsSettings>("VisualsSettings")({
  level: VisualsLevel,
}) {}

export const DEFAULT_VISUALS = VisualsSettings.make({ level: "rich" });

/** This Host's copy of the setting (capability `sessions.visuals`). */
export const GetVisualsSettings = Rpc.make("sessions.visuals", {
  payload: {},
  success: VisualsSettings,
  error: Unsupported,
});

/** Replaces the Host's copy; Agent Sessions whose Harness opens after it follow it. */
export const SetVisualsSettings = Rpc.make("sessions.setVisuals", {
  payload: { settings: VisualsSettings },
  error: Schema.Union([Unsupported, FileError]),
});

export class VisualsRpcs extends RpcGroup.make(GetVisualsSettings, SetVisualsSettings) {}
