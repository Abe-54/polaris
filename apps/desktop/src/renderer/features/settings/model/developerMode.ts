/**
 * Settings → About's Developer Mode (ENG-709): the switch as the release app and Polaris Dev
 * show it, and each Host's Polaris Workspace with how it was found.
 */
import type { DeveloperMode } from "@polaris/protocol";
import type { HostView, Plain } from "../../../../shared/api.ts";

/** What a Host told us, or why it couldn't. */
export type HostDeveloperMode =
  | { readonly kind: "mode"; readonly mode: Plain<DeveloperMode> }
  | { readonly kind: "older-daemon" }
  | { readonly kind: "failed" };

export interface DeveloperModeSwitch {
  readonly checked: boolean;
  readonly locked: boolean;
  readonly caption: string;
}

/** Polaris Dev shows it on and locked: its leases turn it on, and the setting is left alone. */
export const developerModeSwitch = (
  enabled: boolean,
  developmentBuild: boolean
): DeveloperModeSwitch => {
  if (developmentBuild)
    return {
      checked: true,
      locked: true,
      caption: "On in Polaris Dev, on every host it connects to; the setting stays as it is",
    };

  return {
    checked: enabled,
    locked: false,
    caption: enabled
      ? "On for all your hosts · Polaris records its own traces and shows its daemon sources"
      : "Off · for building Polaris itself: its own traces and daemon sources",
  };
};

/** The select's value for "find by git remote". */
export const BY_REMOTE = "remote";

export interface PolarisWorkspaceRow {
  readonly hostKey: string;
  readonly fact: string;
  /** The override, or BY_REMOTE; null when the Host can't choose one. */
  readonly value: string | null;
}

const workspaceName = (
  names: ReadonlyMap<string, string>,
  mode: Plain<DeveloperMode>
): string | null =>
  mode.polarisWorkspaceId === null
    ? null
    : (names.get(mode.polarisWorkspaceId) ?? mode.polarisWorkspaceId);

const factOf = (names: ReadonlyMap<string, string>, mode: Plain<DeveloperMode>) => {
  const name = workspaceName(names, mode);

  if (name === null) return "No polaris workspace found";

  return mode.polarisWorkspaceSource === "override"
    ? `${name} · chosen`
    : `${name} · by git remote`;
};

/** One row per connected Host: its Polaris Workspace, or why it has none. */
export const polarisWorkspaceRow = (
  host: Pick<HostView, "key">,
  state: HostDeveloperMode | undefined,
  names: ReadonlyMap<string, string>
): PolarisWorkspaceRow => {
  if (state === undefined) return { hostKey: host.key, fact: "Reading…", value: null };

  if (state.kind === "older-daemon")
    return { hostKey: host.key, fact: "Needs a newer daemon", value: null };

  if (state.kind === "failed")
    return { hostKey: host.key, fact: "Couldn't read developer mode", value: null };

  return {
    hostKey: host.key,
    fact: factOf(names, state.mode),
    value:
      state.mode.polarisWorkspaceSource === "override" && state.mode.polarisWorkspaceId !== null
        ? state.mode.polarisWorkspaceId
        : BY_REMOTE,
  };
};
