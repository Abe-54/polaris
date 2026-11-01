/**
 * Daemon Sources in Data (CONTEXT.md; ENG-714): the Daemon lists them only in Developer Mode. With
 * a Polaris Workspace they come only to its checkouts; with none, a Polaris switch shows them.
 */
import type { DataSource, DeveloperMode } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export const isDaemonSource = (source: Pick<DataSource, "foundIn">) =>
  source.foundIn.kind === "daemon";

/** The switch shows where Daemon Sources have no Polaris checkout to sit in (as in Traces). */
export const daemonSwitchShown = (
  sources: ReadonlyArray<DataSource>,
  mode: Pick<DeveloperMode, "polarisWorkspaceId"> | null
) => sources.some(isDaemonSource) && (mode === null || mode.polarisWorkspaceId === null);

/** The sources Data shows: Daemon Sources wait for the switch wherever it shows. */
export const shownSources = (
  sources: ReadonlyArray<DataSource>,
  switchShown: boolean,
  on: boolean
): ReadonlyArray<DataSource> =>
  switchShown && !on ? sources.filter((source) => !isDaemonSource(source)) : sources;

/** Off by default, per Host. */
const switchStore = createStore<Readonly<Record<string, boolean>>>(() => ({}));

export const setDaemonSwitch = (hostKey: string, on: boolean) =>
  switchStore.setState({ [hostKey]: on });

export const useDaemonSwitch = (hostKey: string) =>
  useStore(switchStore, (s) => s[hostKey] ?? false);
