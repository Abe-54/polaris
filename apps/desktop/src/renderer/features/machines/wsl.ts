/**
 * "Add a host" on Windows (Paper W1–W3): the WSL distros section above the
 * ssh aliases, its empty states, and the copy a distro Host carries. Pure, so
 * every state is tested on macOS; the section is hidden off Windows.
 */
import { Match } from "effect";
import type { MachineView, WslDistrosView, WslDistroView } from "../../../shared/api.ts";
import { type ClientCopy, clientCopy } from "../../../shared/clientCopy.ts";

/** The one command Polaris suggests and never runs (ADR 0036: an admin prompt and a reboot). */
export const WSL_INSTALL_COMMAND = "wsl --install";

export interface WslEmpty {
  readonly kind: "empty";
  readonly body: string;
  /** Shown in a well with "Copy command"; null when there is nothing to run. */
  readonly command: string | null;
  readonly hint: string | null;
}

export type WslSection =
  | { readonly kind: "loading" }
  /** Not Windows: no WSL section at all, and the page reads as it does on a Mac. */
  | { readonly kind: "hidden" }
  | { readonly kind: "distros"; readonly distros: ReadonlyArray<WslDistroView> }
  | WslEmpty;

const empty = (body: string, command: string | null, hint: string | null): WslEmpty => ({
  kind: "empty",
  body,
  command,
  hint,
});

/** What the WSL section shows for the main process's answer (null while it is on its way). */
export const wslSection = (view: WslDistrosView | null): WslSection => {
  if (view === null) return { kind: "loading" };

  return Match.value(view.status).pipe(
    Match.when("unsupported", (): WslSection => ({ kind: "hidden" })),
    Match.when("distros", (): WslSection => ({ kind: "distros", distros: view.distros })),
    Match.when("not-installed", () =>
      empty(
        "WSL isn't installed on this PC. Install it in an administrator PowerShell, restart Windows, then come back: Polaris looks again each time this card opens.",
        WSL_INSTALL_COMMAND,
        "Installs WSL 2 with Ubuntu; needs Windows 10 2004 or newer"
      )
    ),
    Match.when("no-distros", () =>
      empty(
        "WSL is installed but has no distro yet. Install one, then look again.",
        "wsl --install -d Ubuntu",
        "Any WSL 2 distro works; WSL 1 ones can't run the daemon"
      )
    ),
    Match.when("failed", () =>
      empty(
        `WSL didn't answer when Polaris listed its distros${view.detail === null ? "." : `: ${view.detail}`}`,
        null,
        "Check that wsl --list --verbose works in a terminal, then look again"
      )
    ),
    Match.exhaustive
  );
};

const stateWord = (distro: WslDistroView) =>
  Match.value(distro.state).pipe(
    Match.when("running", () => "running"),
    Match.when("stopped", () => "stopped"),
    Match.orElse(() => null)
  );

/** "WSL 2 · running · default", or why a distro can't be picked ("WSL 1: convert it…"). */
export const distroCaption = (distro: WslDistroView): string => {
  if (distro.unsupported !== null) return distro.unsupported;
  const parts = [`WSL ${distro.version}`, stateWord(distro), distro.isDefault ? "default" : null];

  return parts.filter((part) => part !== null).join(" · ");
};

/** Where a Host is: "This Mac", "ssh studio" or "wsl Ubuntu" (rule/glossary-lowercase). */
export const hostWhere = (machine: Pick<MachineView, "kind" | "alias">): string => {
  if (machine.kind === "local" || machine.alias === null) return clientCopy().localHost;

  return `${machine.kind === "wsl" ? "wsl" : "ssh"} ${machine.alias}`;
};

/** The footer of "Add a host" once a distro is picked (W1): where its work lives and when it stops. */
export const wslFooter = (distro: string): string =>
  `Workspaces live inside the distro; Windows sees them at \\\\wsl.localhost\\${distro}. The distro stays up while Polaris is connected to it.`;

/** The page's intro, one line in the 680px column (Paper HS-D2); WSL only when it is in the picture. */
export const hostsIntro = (wsl: boolean, copy: ClientCopy = clientCopy()): string =>
  `The machines your agents run on. Each runs its own daemon; ${copy.machine} reaches the others over ${wsl ? "SSH or WSL" : "SSH"}.`;

export const addHint = (wsl: boolean): string =>
  wsl
    ? "A WSL distro on this PC, or an alias from ~/.ssh/config. The first install asks for your approval."
    : "Pick an alias from ~/.ssh/config; the first install asks for your approval.";
