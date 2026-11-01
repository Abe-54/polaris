/**
 * The one seam to the Desktop's per-Host Developer Mode state (ENG-712): it turns each Host's
 * mode into the gate Self-Traces follow. Until that state is wired here, Self-Traces stay off.
 */
import { type SelfTraceGate, selfTraceGate } from "@polaris/client";
import type { DeveloperMode } from "@polaris/protocol";
import type { DeveloperModeSource } from "./source.ts";

/** Per-Host Developer Mode as the Desktop keeps it: each Host's last known mode, and changes. */
export interface HostDeveloperModes {
  readonly all: () => ReadonlyMap<string, DeveloperMode>;
  readonly onChange: (listener: () => void) => () => void;
}

const noHosts: HostDeveloperModes = {
  all: () => new Map(),
  onChange: () => () => undefined,
};

/** The Polaris Workspace's Host (else the local one) and its effective mode, from `modes`. */
export const developerModeSource = (
  localKey: string,
  modes: HostDeveloperModes = noHosts
): DeveloperModeSource => ({
  current: () => selfTraceGate(modes.all(), localKey),
  subscribe: (listener: (gate: SelfTraceGate) => void) =>
    modes.onChange(() => listener(selfTraceGate(modes.all(), localKey))),
});
