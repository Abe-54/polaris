/**
 * Traces (⌘5; DESIGN.md, Traces; ADR 0094): the layout and its slots, the hooks over the Traces
 * IPC contract, and the fixture layer. The interface for the shell and other features.
 */
export { TracesMode } from "./ui/LazyTracesMode.tsx";

export { tracesUnavailable, useTracesUnavailable } from "./model/availability.ts";

export type { TracesSessionKey } from "./model/session.ts";

export {
  selectSpan,
  selectTrace,
  type TracesSelection,
  tracesSelection,
  useTracesSelection,
} from "./model/store.ts";

export {
  type Loaded,
  TracesLayer,
  useSpan,
  useTrace,
  useTraces,
  useTracesApi,
} from "./data/hooks.tsx";

export { liveTracesApi, type TracesApi } from "./data/api.ts";

export { type TracesSettingsApi, liveTracesSettingsApi } from "./settings/api.ts";

export {
  TracesSettingsLayer,
  useWorkspaceTracesSettings,
  type WorkspaceTracesSettingsState,
} from "./settings/hooks.tsx";

export { clearTracesSettingsTarget, tracesSettingsTarget } from "./settings/focus.ts";

export { KEEP_LINE, tracesSettingsUnavailable } from "./settings/model.ts";

export { TracesSettingsCard } from "./settings/ui/TracesSettingsCard.tsx";
