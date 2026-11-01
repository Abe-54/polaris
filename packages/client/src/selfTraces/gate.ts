/**
 * Which Host receives a Client's Self-Traces, and whether they are on: the Host that holds the
 * Polaris Workspace (else the local Daemon), traced exactly while its Developer Mode is effective.
 */
import type { DeveloperMode } from "@polaris/protocol";

export interface SelfTraceGate {
  readonly hostKey: string;
  readonly enabled: boolean;
}

/**
 * `modes` holds each Host's last known Developer Mode, kept while it is unreachable so its Spans
 * buffer. The local Host wins when several hold a Polaris Workspace; then the first by key.
 */
export const selfTraceGate = (
  modes: ReadonlyMap<string, DeveloperMode>,
  localKey: string
): SelfTraceGate => {
  const holders = [...modes]
    .flatMap(([key, mode]) => (mode.polarisWorkspaceId === null ? [] : [key]))
    .sort((a, b) => a.localeCompare(b));

  const hostKey = holders.includes(localKey) ? localKey : (holders[0] ?? localKey);

  return { hostKey, enabled: modes.get(hostKey)?.effective ?? false };
};
