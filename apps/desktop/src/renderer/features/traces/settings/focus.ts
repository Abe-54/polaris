/**
 * Which Workspace Settings → Traces opens on. The setup views set it before opening Settings, so
 * they land on their own Workspace; otherwise the page starts on the selected one.
 */
import { createStore } from "zustand/vanilla";

export interface TracesSettingsTarget {
  readonly hostKey: string;
  readonly workspaceId: string;
}

export const tracesSettingsTarget = createStore<TracesSettingsTarget | null>(() => null);

/** Read once by the page as it opens, then cleared so a later ⌘, starts on the selection. */
export const takeTracesSettingsTarget = (): TracesSettingsTarget | null => {
  const target = tracesSettingsTarget.getState();

  tracesSettingsTarget.setState(null, true);

  return target;
};
