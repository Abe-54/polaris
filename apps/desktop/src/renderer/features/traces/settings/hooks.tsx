/**
 * Reading and saving one Workspace's Traces settings over whichever `TracesSettingsApi` the
 * nearest `TracesSettingsLayer` provides. A save shows at once and rolls back when refused.
 */
import type {
  WorkspaceId,
  WorkspaceTracesSettings,
  WorkspaceTracesSettingsUpdate,
} from "@polaris/protocol";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import type { IpcError } from "../../../../shared/api.ts";
import type { Loaded } from "../data/hooks.tsx";
import { liveTracesSettingsApi, type TracesSettingsApi } from "./api.ts";

const ApiContext = createContext<TracesSettingsApi>(liveTracesSettingsApi);

export const TracesSettingsLayer = ({
  api,
  children,
}: {
  readonly api: TracesSettingsApi;
  readonly children: ReactNode;
}) => <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;

export const useTracesSettingsApi = () => useContext(ApiContext);

export interface WorkspaceTracesSettingsState {
  readonly settings: Loaded<WorkspaceTracesSettings>;
  /** Null once saved; the refusal otherwise, with the settings as they were. */
  readonly update: (patch: WorkspaceTracesSettingsUpdate) => Promise<IpcError | null>;
}

const LOADING = { status: "loading" } as const;

/** Nothing is read while `at` is null. */
export const useWorkspaceTracesSettings = (
  at: { readonly hostKey: string; readonly workspaceId: WorkspaceId } | null
): WorkspaceTracesSettingsState => {
  const api = useTracesSettingsApi();
  const [settings, setSettings] = useState<Loaded<WorkspaceTracesSettings>>(LOADING);
  const hostKey = at?.hostKey ?? null;
  const workspaceId = at?.workspaceId ?? null;

  useEffect(() => {
    setSettings(LOADING);

    if (hostKey === null || workspaceId === null) return undefined;
    let live = true;

    void api.get(hostKey, workspaceId).then((result) => {
      if (live)
        setSettings(
          result.ok
            ? { status: "ready", value: result.value }
            : { status: "failed", error: result.error }
        );
    });

    return () => {
      live = false;
    };
  }, [api, hostKey, workspaceId]);

  const update = useCallback(
    async (patch: WorkspaceTracesSettingsUpdate) => {
      if (hostKey === null || workspaceId === null || settings.status !== "ready")
        return { code: "NotReady", message: "These settings are still being read" };
      const before = settings.value;

      setSettings({ status: "ready", value: { ...before, ...patch } });
      const result = await api.set(hostKey, workspaceId, patch);

      setSettings({ status: "ready", value: result.ok ? result.value : before });

      return result.ok ? null : result.error;
    },
    [api, hostKey, workspaceId, settings]
  );

  return { settings, update };
};
