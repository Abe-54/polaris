/**
 * Settings (DESIGN.md, Settings): the frame that replaces the three zones
 * (⌘,, the sidebar's gear, the K menu), Appearance, Harnesses and Usage.
 * Hosts is the `SettingsHosts` slot, filled by features/machines.
 */
export { settingsCommands } from "./actions.ts";

export { withSavedModels } from "./model/defaults.ts";

export {
  connectSettings,
  DEFAULT_APPEARANCE,
  setAppearance,
  setSessionPrefs,
  setSessionDefault,
  settingsStore,
  useSessionDefault,
  useSettings,
} from "./store.ts";

export { SettingsPage } from "./ui/SettingsPage.tsx";

export { useOpenEditorSettings } from "./editor/index.ts";

export { HostResources } from "./ui/HostResources.tsx";

export { ConstellationDefaultsPublisher } from "./defaultsSync.ts";

export { IdleCompactionPublisher } from "./idleCompactionSync.ts";

export { VisualsPublisher } from "./visualsSync.ts";

export { DeveloperModePublisher } from "./developerModeSync.ts";

export {
  connectHostDeveloperModes,
  type HostDeveloperModeView,
  hostDeveloperModesStore,
  useHostDeveloperMode,
  useHostDeveloperModes,
} from "./hostDeveloperModes.ts";

export { setResourcesClient, type ResourcesClient } from "./resources.ts";
