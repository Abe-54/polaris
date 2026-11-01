/**
 * Each Host's Developer Mode as Traces reads it: the Desktop App's per-Host state (ENG-709),
 * unless a test or preview says otherwise with `TracesDeveloperModeLayer`.
 */
import { type DeveloperMode, SELF_TRACE_SERVICES, SELF_TRACES_CAPABILITY } from "@polaris/protocol";
import { createContext, createElement, type ReactNode, useContext } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { useApp } from "../../../shell/hooks.ts";
import {
  type HostDeveloperModeView,
  useHostDeveloperMode as useWatchedDeveloperMode,
} from "../../settings/hostDeveloperModes.ts";

type Read = (hostKey: string) => HostDeveloperModeView | null;

/** Null reads the Desktop App's watched state. */
const DeveloperModeContext = createContext<Read | null>(null);

/** Tests and previews say what each Host's Developer Mode is. */
export const TracesDeveloperModeLayer = ({
  read,
  children,
}: {
  readonly read: Read;
  readonly children: ReactNode;
}) => createElement(DeveloperModeContext.Provider, { value: read }, children);

export const useHostDeveloperMode = (hostKey: string): HostDeveloperModeView | null => {
  const read = useContext(DeveloperModeContext);
  const watched = useWatchedDeveloperMode(hostKey);

  return read === null ? watched : read(hostKey);
};

const SELF_SERVICES: ReadonlySet<string> = new Set(SELF_TRACE_SERVICES);

/** A Trace one of Polaris's own processes sent. */
export const isSelfTrace = (trace: { readonly service: string }) =>
  SELF_SERVICES.has(trace.service);

/**
 * The Polaris switch shows where Self-Traces have no checkout to sit in: the Host stores them,
 * Developer Mode is on, and no Workspace holds Polaris's code.
 */
export const polarisSwitchShown = (
  host: Pick<HostView, "status"> | undefined,
  mode: Pick<DeveloperMode, "effective" | "polarisWorkspaceId"> | null
) =>
  host !== undefined &&
  host.status.state === "connected" &&
  host.status.capabilities.includes(SELF_TRACES_CAPABILITY) &&
  mode !== null &&
  mode.effective &&
  mode.polarisWorkspaceId === null;

export const usePolarisSwitchShown = (hostKey: string) => {
  const mode = useHostDeveloperMode(hostKey);

  return useApp((s) =>
    polarisSwitchShown(
      s.hosts.find((h) => h.key === hostKey),
      mode
    )
  );
};
