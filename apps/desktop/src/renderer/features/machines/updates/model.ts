/**
 * What a Host's row says about its Daemon update, from `MachineView.daemon`:
 * an update to offer, the work in progress, what the last one did, or why it
 * stopped. Pure, so every state is tested (DESIGN.md, Settings · Hosts).
 */
import { clientCopy } from "../../../../shared/clientCopy.ts";
import type { DaemonUpdateProblem, DaemonUpdateView } from "./contract.ts";

/** How long "Upgraded to …" stays on the row after an update. */
export const UPDATED_NOTE_MS = 24 * 60 * 60 * 1000;

export type FailureAction = "retry" | "copy-command" | "open-ssh";

export interface UpdateFailure {
  /** The kicker for tests and data attributes. */
  readonly reason: string;
  readonly title: string;
  readonly body: string;
  /** The command to run, or ssh's or the installer's own line, in a well. */
  readonly detail: string | null;
  readonly actions: ReadonlyArray<{ readonly label: string; readonly action: FailureAction }>;
}

export type UpdateLine =
  | { readonly kind: "none" }
  | {
      readonly kind: "available";
      readonly text: string;
      /** False while the Host isn't connected: the update waits for it. */
      readonly canUpdate: boolean;
      readonly caption: string | null;
    }
  | {
      readonly kind: "busy";
      readonly text: string;
      /** 0–1 from the bytes really sent; null when there are none to count. */
      readonly fraction: number | null;
    }
  | { readonly kind: "updated"; readonly text: string }
  /** A Host that doesn't follow the app-wide switch says so while nothing else shows. */
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "failed"; readonly failure: UpdateFailure };

const NONE: UpdateLine = { kind: "none" };

const RETRY = { label: "Retry", action: "retry" } as const;

const COPY = { label: "Copy command", action: "copy-command" } as const;

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** "4.2 of 18.0 MB". */
export const transferText = (bytes: number, total: number): string =>
  `${megabytes(bytes)} of ${megabytes(total)} MB`;

/** "just now", "12m ago", "3h ago", "3d ago". */
const ago = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);

  if (minutes < 1) return "just now";

  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

const sshFailure = (
  label: string,
  alias: string,
  installed: string,
  problem: DaemonUpdateProblem
): UpdateFailure => {
  const kept = `${label} still runs ${installed}.`;

  switch (problem.sshFailure) {
    case "host-key":
      return {
        reason: "host-key",
        title: `${label}'s host key isn't trusted`,
        body: `${kept} Connect once in a terminal and check the key; if it changed and you didn't rebuild the machine, don't connect.`,
        detail: `ssh ${alias}`,
        actions: [{ label: "Open in terminal", action: "open-ssh" }, RETRY],
      };
    case "auth":
      return {
        reason: "auth",
        title: `${label} refused the key`,
        body: `${kept} Polaris never answers password or 2FA prompts. Load a key into ssh-agent, then retry.`,
        detail: problem.message === "" ? null : problem.message,
        actions: [RETRY, { label: "Open in terminal", action: "open-ssh" }],
      };
    default:
      return {
        reason: "ssh",
        title: `Polaris couldn't reach ${label} over SSH`,
        body: `${kept} Retry once ssh reaches it from a terminal.`,
        detail: problem.message === "" ? null : problem.message,
        actions: [RETRY],
      };
  }
};

/** Why the last update stopped, in words, with at most one fix (rule/say-what-happened). */
export const updateFailure = (
  label: string,
  alias: string | null,
  installed: string | null,
  problem: DaemonUpdateProblem | null
): UpdateFailure => {
  const running = installed ?? "its daemon";
  const kept = `${label} still runs ${running}.`;
  const detail = problem === null || problem.message === "" ? null : problem.message;

  switch (problem?.kind) {
    case "ssh":
      return sshFailure(label, alias ?? "localhost", running, problem);
    case "host-setup":
      return {
        reason: "host-setup",
        title: `${label} is missing libraries the daemon needs`,
        body: `${kept} ${problem.message} An administrator can install them; then retry.`,
        detail: problem.command,
        actions: problem.command === null ? [RETRY] : [RETRY, COPY],
      };
    case "unsupported":
      return {
        reason: "unsupported",
        title: `This build of Polaris can't run on ${label}`,
        body: `${kept} ${problem.message}`,
        detail: null,
        actions: [],
      };
    case "task-conflict":
      return {
        reason: "task-conflict",
        title: `Another Polaris home holds the sign-in task on ${label}`,
        body: `${kept} Retry to see which home holds it and take the task over.`,
        detail,
        actions: [RETRY],
      };
    case "missing-build":
      return {
        reason: "missing-build",
        title: `This app has no daemon build for ${label}`,
        body: `${kept} ${problem.message}`,
        detail: null,
        actions: [],
      };
    default:
      return {
        reason: "failed",
        title: `Upgrading ${label} didn't finish`,
        body: `${kept} Nothing half-installed is left running.`,
        detail,
        actions: [RETRY],
      };
  }
};

const busy = (daemon: DaemonUpdateView, label: string): UpdateLine | null => {
  const progress = daemon.progress;
  const target = daemon.bundledVersion ?? "the new daemon";

  switch (progress?.stage) {
    case "checking":
      return { kind: "busy", text: `Checking ${label}`, fraction: null };
    case "downloading": {
      if (progress.via === "host")
        return { kind: "busy", text: `Downloading polaris ${target} on ${label}`, fraction: null };
      const { bytes, total } = progress;
      const counted = total > 0;
      const where = `Downloading polaris ${target} to ${clientCopy().machine}`;

      return {
        kind: "busy",
        text: counted ? `${where} · ${transferText(bytes, total)}` : where,
        fraction: counted ? Math.min(1, bytes / total) : null,
      };
    }

    case "uploading": {
      const { bytes, total } = progress;
      const counted = total > 0;

      return {
        kind: "busy",
        text: counted
          ? `Copying polaris ${target} · ${transferText(bytes, total)}`
          : `Copying polaris ${target}`,
        fraction: counted ? Math.min(1, bytes / total) : null,
      };
    }

    case "switching":
      return {
        kind: "busy",
        text: `Switching to ${target}; agent sessions keep going`,
        fraction: null,
      };
    default:
      return null;
  }
};

export interface UpdateLineInput {
  readonly label: string;
  readonly alias: string | null;
  readonly connected: boolean;
  readonly daemon: DaemonUpdateView | null;
  readonly now: number;
}

/** The row's update line at `now`. */
export const updateLine = ({
  label,
  alias,
  connected,
  daemon,
  now,
}: UpdateLineInput): UpdateLine => {
  if (daemon === null || !daemon.managed) return NONE;
  const working = busy(daemon, label);

  if (working !== null) return working;
  const last = daemon.lastUpdate;

  if (last?.result === "failed" || daemon.progress?.stage === "failed")
    return {
      kind: "failed",
      failure: updateFailure(label, alias, daemon.installedVersion, last?.problem ?? null),
    };

  if (daemon.updateAvailable) {
    const target = daemon.bundledVersion ?? "?";

    if (!connected && daemon.keepUpToDate)
      return { kind: "note", text: `Upgrades to ${target} when it connects` };

    return {
      kind: "available",
      text: `${target} available${daemon.keepUpToDate ? "" : " · upgrades its daemon only when you ask"}`,
      canUpdate: connected,
      caption: connected ? null : `Upgrades once ${label} is connected`,
    };
  }

  if (last?.result === "updated" && now - last.at < UPDATED_NOTE_MS)
    return {
      kind: "updated",
      text: `Upgraded to ${last.version ?? daemon.installedVersion ?? "?"} · ${ago(now - last.at)}`,
    };

  if (daemon.keepUpToDateOverride === null) return NONE;

  return {
    kind: "note",
    text: daemon.keepUpToDateOverride
      ? "Keeps its daemon up to date on its own"
      : "Upgrades its daemon only when you ask",
  };
};

/** The override the row's menu shows checked. */
export type OverrideChoice = "default" | "on" | "off";

export const overrideChoice = (daemon: DaemonUpdateView): OverrideChoice => {
  if (daemon.keepUpToDateOverride === null) return "default";

  return daemon.keepUpToDateOverride ? "on" : "off";
};

export const overrideValue = (choice: OverrideChoice): boolean | null => {
  if (choice === "default") return null;

  return choice === "on";
};

/** "Use the app setting (on)". */
export const defaultChoiceLabel = (daemon: DaemonUpdateView): string =>
  `Use the app setting (${daemon.keepDaemonsUpToDate ? "on" : "off"})`;

const PLATFORMS = new Map([
  ["darwin", "macOS"],
  ["linux", "Linux"],
  ["win32", "Windows"],
  ["windows", "Windows"],
]);

/** "darwin-arm64" → "macOS arm64", "linux-x64" → "Linux x64", "windows-x64" → "Windows x64". */
export const platformLabel = (platform: string): string => {
  const [os = platform, ...arch] = platform.split("-");

  return [PLATFORMS.get(os) ?? os, ...arch].join(" ");
};
