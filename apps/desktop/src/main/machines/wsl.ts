/**
 * WSL 2 distros as Hosts in Settings (Windows, experimental): the distro list
 * the "Add a host" card shows and the copy the install flow uses for a
 * distro. Pure; `Machines` runs the discovery. See docs/adr/0036-wsl-hosts.md.
 */
import type { WslDiscovery, WslDistro } from "@polaris/client/wsl";
import { Match } from "effect";
import type { WslDistrosView, WslDistroView } from "../../shared/api.ts";

/** What a check is doing while it runs, under the card's "Checking <host>". */
export const PROBING_WSL = "Asking the distro for its platform and any installed daemon.";

export const COPYING_WSL = "Copying the build into the distro and checking its SHA-256";

/** Why a listed distro can't be a Host; null when it can. */
export const unsupportedReason = (distro: WslDistro): string | null =>
  distro.version === 1 ? "WSL 1: convert it with wsl --set-version first" : null;

export const distroView = (distro: WslDistro): WslDistroView => ({
  name: distro.name,
  version: distro.version,
  state: distro.state,
  isDefault: distro.isDefault,
  unsupported: unsupportedReason(distro),
});

const empty = (status: WslDistrosView["status"], detail: string | null = null): WslDistrosView => ({
  status,
  distros: [],
  detail,
});

/** The discovery as the renderer shows it. */
export const wslDistrosView = (discovery: WslDiscovery): WslDistrosView =>
  Match.value(discovery).pipe(
    Match.tagsExhaustive({
      Distros: ({ distros }) => ({
        status: "distros" as const,
        distros: distros.map(distroView),
        detail: null,
      }),
      NoDistros: () => empty("no-distros"),
      NotInstalled: ({ detail }) => empty("not-installed", detail),
      Unsupported: () => empty("unsupported"),
      Failed: ({ detail }) => empty("failed", detail),
    })
  );
