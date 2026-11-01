/**
 * What Self-Traces gate on: the Host that holds the Polaris Workspace and whether its Developer
 * Mode is effective. The Desktop's per-Host Developer Mode state supplies it (`adapter.ts`).
 */
import type { SelfTraceGate } from "@polaris/client";

export interface DeveloperModeSource {
  /** The target Host and whether it traces now. */
  readonly current: () => SelfTraceGate;
  /** Called on every change of `current`; returns the unsubscribe. */
  readonly subscribe: (listener: (gate: SelfTraceGate) => void) => () => void;
}
