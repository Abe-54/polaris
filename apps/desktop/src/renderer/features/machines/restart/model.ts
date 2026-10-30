/**
 * Restart daemon's words (DESIGN.md, Settings → Hosts redesign, HS-D4): whether to confirm,
 * what the confirm says will be interrupted, the command line, and the Restarting, Back and
 * Failed copy. Pure, so every clause and plural is tested.
 */
import { Match } from "effect";
import type {
  RestartDaemonResult,
  RestartPreviewView,
  ServiceManagerView,
} from "../../../../shared/restart.ts";

type Interrupts = NonNullable<RestartPreviewView["interrupts"]>;

/** Confirm only when something would be interrupted; a Daemon that can't say is asked about too. */
export const needsConfirm = (preview: RestartPreviewView): boolean => {
  const it = preview.interrupts;

  if (it === null) return true;

  return it.workingSessions.length > 0 || it.terminals > 0 || it.pendingApprovals > 0;
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const sessionsClause = (n: number) =>
  n === 1
    ? "1 agent session is working. Its turn stops and waits for you to continue; a constellation worker continues once on its own."
    : `${n} agent sessions are working. Their turns stop and wait for you to continue; a constellation worker continues once on its own.`;

const terminalsClause = (n: number) =>
  `${count(n, "terminal", "terminals")} ${n === 1 ? "closes" : "close"}`;

const approvalsClause = (n: number) =>
  `${count(n, "pending approval", "pending approvals")} ${n === 1 ? "is" : "are"} withdrawn`;

/** The confirm's body, each clause only when its count isn't zero. */
export const confirmBody = (interrupts: Interrupts | null): string => {
  if (interrupts === null)
    return "Its daemon can't say what is running. Working turns stop and wait for you to continue.";

  const rest = [
    ...(interrupts.terminals > 0 ? [terminalsClause(interrupts.terminals)] : []),
    ...(interrupts.pendingApprovals > 0 ? [approvalsClause(interrupts.pendingApprovals)] : []),
  ];

  const tail = rest.length === 0 ? [] : [`${rest.join(" and ")}.`];

  const head =
    interrupts.workingSessions.length > 0
      ? [sessionsClause(interrupts.workingSessions.length)]
      : [];

  return [...head, ...tail].map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
};

/** The well shows up to three working sessions, then "+n more". */
export const WELL_SESSIONS = 3;

export const moreSessions = (interrupts: Interrupts | null): string | null => {
  const extra = (interrupts?.workingSessions.length ?? 0) - WELL_SESSIONS;

  return extra > 0 ? `+${extra} more` : null;
};

export type Platform = "macos" | "linux" | "windows";

export const platformOf = (name: string | null | undefined): Platform | null => {
  if (name === null || name === undefined) return null;

  if (name.startsWith("darwin") || name.startsWith("macos")) return "macos";

  if (name.startsWith("win")) return "windows";

  return name.startsWith("linux") ? "linux" : null;
};

const MANAGER_OF: Record<Platform, ServiceManagerView> = {
  macos: "launchd",
  linux: "systemd",
  windows: "task-scheduler",
};

export const managerFor = (platform: Platform | null): ServiceManagerView | null =>
  platform === null ? null : MANAGER_OF[platform];

/** The manager as a sentence's subject: "launchd", "Task Scheduler". */
export const managerName = (manager: ServiceManagerView | null): string =>
  Match.value(manager).pipe(
    Match.when("launchd", () => "launchd"),
    Match.when("systemd", () => "systemd"),
    Match.when("supervisor", () => "Polaris's supervisor"),
    Match.when("task-scheduler", () => "Task Scheduler"),
    Match.orElse(() => "The service manager")
  );

const VERB: Record<ServiceManagerView, string> = {
  launchd: "LAUNCHCTL KICKSTART -K",
  systemd: "SYSTEMCTL --USER RESTART",
  supervisor: "POLARIS SUPERVISOR RESTART",
  "task-scheduler": "SCHTASKS /RUN",
};

/** How the command reaches the host: "OVER SSH", "THROUGH WSL.EXE", "ON THIS MAC". */
export const channelWords = (kind: "local" | "ssh" | "wsl", machine: string): string =>
  Match.value(kind).pipe(
    Match.when("ssh", () => "OVER SSH"),
    Match.when("wsl", () => "THROUGH WSL.EXE"),
    Match.orElse(() => `ON ${machine.toUpperCase()}`)
  );

/** "LAUNCHCTL KICKSTART -K · OVER SSH". */
export const commandLine = (manager: ServiceManagerView | null, channel: string): string =>
  manager === null ? channel : `${VERB[manager]} · ${channel}`;

/** "launchd started it again · waiting for it to answer". */
export const restartingCaption = (manager: ServiceManagerView | null): string =>
  `${managerName(manager)} started it again · waiting for it to answer`;

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/** "STOPPED 14:02:31 · 3 TURNS INTERRUPTED" (the count when the preview knew it). */
export const restartingFooter = (stoppedAt: number, turns: number | null): string =>
  turns === null || turns === 0
    ? `STOPPED ${clock(stoppedAt)}`
    : `STOPPED ${clock(stoppedAt)} · ${count(turns, "TURN", "TURNS")} INTERRUPTED`;

type Back = Extract<RestartDaemonResult, { readonly outcome: "back" }>;

/** "2 sessions wait for you to continue", or that nothing was interrupted. */
export const backCaption = (result: Back): string => {
  const turns = result.interruptedTurns;

  if (turns === null) return "Its agent sessions are kept";

  if (turns === 0) return "Nothing was interrupted";

  return `${count(turns, "session waits", "sessions wait")} for you to continue`;
};

export type Failed = Extract<RestartDaemonResult, { readonly outcome: "failed" }>;

export const failedTitle = (label: string) => `The daemon on ${label} didn't come back`;

/** Why, per stage, then what it means for the host. */
export const failedBody = (result: Failed, label: string): string => {
  const kept = `Nothing runs on ${label} until it does; its agent sessions are kept and wait for you.`;
  const manager = managerName(result.manager);

  return Match.value(result.stage).pipe(
    Match.when("channel", () => `Polaris couldn't reach ${label} to restart it. ${kept}`),
    Match.when(
      "no-service",
      () => `No service runs the daemon on ${label}, so nothing could start it again. ${kept}`
    ),
    Match.when("service", () => `${manager} couldn't restart the daemon. ${kept}`),
    Match.orElse(() => `${manager} stopped it but couldn't start it again. ${kept}`)
  );
};

/** The sunken well: the command as typed, then its output. */
export const failedWell = (result: Failed): string =>
  [result.command === null ? null : `$ ${result.command}`, result.output.trim() || result.message]
    .filter((line) => line !== null && line !== "")
    .join("\n");
