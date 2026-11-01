/**
 * Keeps every connected Host's Developer Mode equal to the user's (Settings → About, ENG-709):
 * one setting for all Hosts, written when it differs. Polaris Dev never writes it; its main
 * process holds a lease on each Host instead, and this only reads each Host's state.
 */
import { DEVELOPER_MODE_CAPABILITY, type WorkspaceId } from "@polaris/protocol";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useApp } from "../../shell/hooks.ts";
import { polaris } from "../bridge.ts";
import type { HostDeveloperMode } from "./model/developerMode.ts";
import { useSettings } from "./store.ts";

/** Each Host's Developer Mode, by Host key, for About to show. */
export const developerModes = createStore<Readonly<Record<string, HostDeveloperMode>>>(() => ({}));

export const useDeveloperModes = () => useStore(developerModes, (s) => s);

const mark = (hostKey: string, state: HostDeveloperMode) =>
  developerModes.setState((s) => ({ ...s, [hostKey]: state }));

/** What was last asked per Host and connection, so a re-render doesn't ask again. */
const asked = new Map<string, string>();

/** Reads the Host's Developer Mode, and writes `wanted` when it is given and differs. */
export const syncHostDeveloperMode = async (
  hostKey: string,
  wanted: boolean | null
): Promise<boolean> => {
  const current = await polaris().request("developerMode.get", { hostKey });

  if (!current.ok) {
    mark(hostKey, { kind: "failed" });

    return false;
  }

  if (wanted === null || current.value.stored === wanted) {
    mark(hostKey, { kind: "mode", mode: current.value });

    return true;
  }

  const set = await polaris().request("developerMode.set", { hostKey, enabled: wanted });
  mark(hostKey, set.ok ? { kind: "mode", mode: set.value } : { kind: "failed" });

  return set.ok;
};

/** Overrides the Host's Polaris Workspace, or with null goes back to its git remote. */
export const setPolarisWorkspace = async (hostKey: string, workspaceId: WorkspaceId | null) => {
  const set = await polaris().request("developerMode.setWorkspace", { hostKey, workspaceId });

  if (set.ok) mark(hostKey, { kind: "mode", mode: set.value });
};

/** Mounted once in the app; idle unless the setting or the connected Hosts change. */
export const DeveloperModePublisher = () => {
  const hosts = useApp((s) => s.hosts);
  const enabled = useSettings((s) => s.sessions.developerMode);
  const developmentBuild = useSettings((s) => s.developmentBuild);
  // Empty until main has answered: the setting before that is the built-in one, not the user's.
  const loaded = useSettings((s) => s.version !== "");

  useEffect(() => {
    if (!loaded) return;
    const wanted = developmentBuild ? null : enabled;

    for (const host of hosts) {
      if (host.status.state !== "connected") continue;

      if (!host.status.capabilities.includes(DEVELOPER_MODE_CAPABILITY)) {
        mark(host.key, { kind: "older-daemon" });
        continue;
      }

      const key = `${host.key}\u0000${host.status.epoch}`;
      const value = String(wanted);

      if (asked.get(key) === value) continue;
      asked.set(key, value);
      // Tried again on the next change or connection.
      void syncHostDeveloperMode(host.key, wanted).then((ok) => ok || asked.delete(key));
    }
  }, [hosts, enabled, developmentBuild, loaded]);

  return null;
};
