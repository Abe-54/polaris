/**
 * Workspace Traces settings' boundary: `traces.settings` and `traces.setSettings` over IPC
 * (shared/tracesContract.ts). Header values never cross it; fixtures swap in for previews and tests.
 */
import type {
  WorkspaceId,
  WorkspaceTracesSettings,
  WorkspaceTracesSettingsUpdate,
} from "@polaris/protocol";
import type { Result } from "../../../../shared/api.ts";
import { polaris } from "../../bridge.ts";

export interface TracesSettingsApi {
  readonly get: (
    hostKey: string,
    workspaceId: WorkspaceId
  ) => Promise<Result<WorkspaceTracesSettings>>;
  /** Applies the patch and answers the complete settings. */
  readonly set: (
    hostKey: string,
    workspaceId: WorkspaceId,
    patch: WorkspaceTracesSettingsUpdate
  ) => Promise<Result<WorkspaceTracesSettings>>;
}

export const liveTracesSettingsApi: TracesSettingsApi = {
  get: (hostKey, workspaceId) => polaris().request("traces.settings", { hostKey, workspaceId }),
  set: (hostKey, workspaceId, settings) =>
    polaris().request("traces.setSettings", { hostKey, workspaceId, settings }),
};
