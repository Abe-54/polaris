/**
 * Settings' "Allow an app…" (Paper CU1b): the app picked on this Mac or typed for another Host,
 * checked for its Host's id shape, with a warning when it's on the built-in refused list.
 * The Daemon stays the authority; the warning is copy.
 */
import { AppId, builtInRefused } from "@polaris/protocol";
import type { HostFacts } from "./model.ts";

/** An app about to be always-allowed: picked here, or typed for another Host. */
export interface Candidate {
  readonly id: AppId;
  readonly name: string;
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** What the field asks for, by the Host's platform (packages/protocol/computer-use.md, Apps). */
export const idHint = (platform: HostFacts["platform"]): string => {
  switch (platform) {
    case "macos":
      return "The app's bundle id, like com.apple.Safari";
    case "windows":
      return "The app's .exe path, like C:\\Program Files\\Paper\\Paper.exe";
    case "linux":
      return "The app's .desktop id, like org.gnome.Nautilus";
    default:
      return "The app's id on this host";
  }
};

/** Why `raw` isn't an app id on this Host, or null when it can be sent. */
export const appIdProblem = (platform: HostFacts["platform"], raw: string): string | null => {
  const id = raw.trim();

  if (id.length === 0) return "Enter the app's id";

  if (id.length > 1024 || /[\n\r\t]/.test(id)) return "That isn't an app id";

  if (platform === "macos" && !BUNDLE_ID.test(id)) return "A bundle id looks like com.apple.Safari";

  if (platform === "windows" && /[\\/]/.test(id) && !/\.exe$/i.test(id))
    return "A path must end in .exe";

  if (platform === "linux" && id.includes("/")) return "A .desktop id has no slashes";

  return null;
};

/** A typed id as a candidate: Windows paths are named by their file, others by the id itself. */
export const typedCandidate = (raw: string): Candidate => {
  const id = raw.trim();

  return { id: AppId.make(id), name: id.split(/[\\/]/).at(-1) ?? id };
};

export interface RefusedWarning {
  readonly title: string;
  readonly line: string;
}

/** The warning for an app Polaris refuses by default, or null for any other app. */
export const refusedWarning = (app: Candidate, host: string): RefusedWarning | null =>
  builtInRefused(app.id)
    ? {
        title: `Polaris never lets agents use ${app.name} by default`,
        line: `In ${app.name} an agent could run commands, read passwords or change settings on ${host}, past the approvals its session asks for. Every agent session there could use it without asking.`,
      }
    : null;

/** The confirm button: "anyway" only past a warning. */
export const confirmLabel = (app: Candidate, warned: boolean): string =>
  `Always allow ${app.name}${warned ? " anyway" : ""}`;
