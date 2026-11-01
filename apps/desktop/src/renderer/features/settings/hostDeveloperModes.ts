/**
 * Every connected Host's Developer Mode in the renderer (ENG-709), as main watches it: read once
 * at start, then kept current by its `developer-mode` events. A Host absent here is not known.
 */
import type { DeveloperMode } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { PolarisApi, Plain } from "../../../shared/api.ts";

export type HostDeveloperModeView = Plain<DeveloperMode>;

export const hostDeveloperModesStore = createStore<Readonly<Record<string, HostDeveloperModeView>>>(
  () => ({})
);

const put = (hostKey: string, mode: HostDeveloperModeView | null) =>
  hostDeveloperModesStore.setState((s) => {
    const { [hostKey]: _gone, ...rest } = s;

    return mode === null ? rest : { ...rest, [hostKey]: mode };
  }, true);

/** Loads the Hosts' values from main and follows each change; call once per window. */
export const connectHostDeveloperModes = (api: PolarisApi) => {
  const unsubscribe = api.onAppEvent((event) => {
    if (event.kind === "developer-mode") put(event.hostKey, event.mode);
  });

  void api.request("developerMode.hosts", {}).then((result) => {
    if (result.ok) hostDeveloperModesStore.setState((s) => ({ ...result.value, ...s }), true);
  });

  return unsubscribe;
};

/** Every connected Host's Developer Mode, by Host key. */
export const useHostDeveloperModes = () => useStore(hostDeveloperModesStore, (s) => s);

/** The Host's Developer Mode; null while it isn't connected or its Daemon is older. */
export const useHostDeveloperMode = (hostKey: string): HostDeveloperModeView | null =>
  useStore(hostDeveloperModesStore, (s) => s[hostKey] ?? null);
