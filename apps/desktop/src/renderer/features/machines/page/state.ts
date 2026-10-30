/**
 * What the host list and a host page say of a host's connection (DESIGN.md, Settings → Hosts
 * redesign): the Connection State pill, whether Retry now shows, and the mono line under the
 * name. Pure, so each state's words are tested.
 */
import type { MachineView } from "../../../../shared/api.ts";
import { clientCopy } from "../../../../shared/clientCopy.ts";
import { type ConnectionLine, connectionLine, workspacesText } from "../model.ts";
import { platformLabel } from "../updates/model.ts";
import { hostWhere } from "../wsl.ts";

export interface Pill {
  readonly state: ConnectionLine["state"];
  /** "Connected · 47 ms", "Reconnecting · 12s", "Offline · last seen 2h ago". */
  readonly label: string;
  /** Retry now, beside the pill. */
  readonly retry: boolean;
}

/** Where a restart stands, as far as the header is concerned. */
export type RestartPhase = "idle" | "restarting" | "failed";

const RETRIES = new Set<ConnectionLine["state"]>(["reconnecting", "offline", "needs-attention"]);

/** The caption without "for": the pill reads "Reconnecting · 12s". */
const shortCaption = (line: ConnectionLine) => line.caption?.replace(/^for /, "") ?? null;

export const pill = (machine: MachineView, now: number, restart: RestartPhase = "idle"): Pill => {
  if (restart === "failed")
    return { state: "needs-attention", label: "Needs attention", retry: true };
  const line = connectionLine(machine, now);
  const caption = shortCaption(line);

  return {
    state: line.state,
    label: caption === null ? line.label : `${line.label} · ${caption}`,
    // Never on a connected host, nor while a restart is already reconnecting it.
    retry: RETRIES.has(line.state) && restart !== "restarting",
  };
};

const isLocal = (machine: Pick<MachineView, "kind">) => machine.kind === "local";

/** A host's name: "This Mac" for the local Host (HS-D2), whatever the user named it. */
export const hostName = (machine: Pick<MachineView, "kind" | "label">): string =>
  isLocal(machine) ? clientCopy().localHost : machine.label;

/** The local Host's own name ("MacBook Pro") goes in its line; "This Mac" is already the title. */
const where = (machine: MachineView): ReadonlyArray<string> => {
  if (!isLocal(machine)) return [hostWhere(machine)];
  const same = machine.label.toLowerCase() === clientCopy().localHost.toLowerCase();

  return same ? [] : [machine.label];
};

/** "ssh studio · macOS arm64" or "MacBook Pro · macOS arm64": the list row's line. */
export const listLine = (machine: MachineView): string => {
  const platform = machine.status?.host?.platform ?? null;

  return [...where(machine), ...(platform === null ? [] : [platformLabel(platform)])].join(" · ");
};

/** "ssh studio · macOS arm64 · 4 workspaces · daemon 0.5.0": the page header's line. */
export const pageLine = (
  machine: MachineView,
  workspaces: number | null,
  version: string | null
): string =>
  [
    listLine(machine),
    ...(workspaces === null ? [] : [workspacesText(workspaces)]),
    ...(version === null ? [] : [`daemon ${version}`]),
  ].join(" · ");
