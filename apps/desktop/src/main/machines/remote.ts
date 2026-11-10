/**
 * The install flow's side effects on a Host, over its `HostChannel` (ssh, wsl.exe or a
 * local shell; on a Windows Client this PC runs `polaris.exe` directly, `windowsLocal.ts`):
 * probe and plan, then install or upgrade the bundled build, and restart an installed
 * Daemon's service. `Machines` decides when; these do it.
 */
import type { HostChannel } from "@polaris/client/access";
import {
  applyPlan,
  type DaemonBuild,
  type ApplyOptions,
  type InstallPlan,
  type InstallTrigger,
  planInstall,
  platformFromUname,
  probeHost,
  shScript,
  startCommand,
  taskConflictOf,
  type WindowsShell,
} from "@polaris/client/install";
import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { ChildProcessApi } from "@polaris/client/process";
import type { DaemonBuilds } from "./builds.ts";
import type { InstallOutcome, InstallWork } from "./installFlow.ts";
import { reportOutcome } from "./views.ts";
import {
  applyWindowsLocal,
  installedVersion,
  planWindowsLocal,
  startWindowsLocal,
  WINDOWS_PLATFORM,
} from "./windowsLocal.ts";

export interface PlanInput {
  readonly trigger: InstallTrigger;
  readonly approved: ReadonlySet<string>;
  readonly builds: DaemonBuilds;
  /** Runs before a dev build from source starts. */
  readonly onBuild: Effect.Effect<void>;
  /** The Client's platform: on Windows the local Host has no shell (`windowsLocal.ts`). */
  readonly platform?: NodeJS.Platform | undefined;
  /** Runs this PC's `polaris.exe` there; tests script it. */
  readonly processes?: ChildProcessApi | undefined;
}

export type LocalOptions = Pick<PlanInput, "platform" | "processes">;

/** This PC's own Daemon on a Windows Client, run directly rather than through a shell. */
const windowsHome = (channel: HostChannel, platform: NodeJS.Platform | undefined) =>
  channel.kind === "local" && (platform ?? process.platform) === "win32" ? channel.home : null;

export interface Planned {
  readonly platform: string | null;
  readonly installedVersion: string | null;
  readonly bundledVersion: string | null;
  readonly plan: InstallPlan;
  /** The size of the build the plan would install, for the approval card. */
  readonly size: number | null;
  /** A Windows SSH Host's DefaultShell, which its connection must speak; null elsewhere. */
  readonly windowsShell: WindowsShell | null;
}

const sizeOf = (build: DaemonBuild | undefined) =>
  build === undefined ? null : build.files.reduce((total, file) => total + file.size, 0);

/** Probe the Host, find (or in dev, build) its platform's build, and plan. */
export const planFor = Effect.fn("planFor")(function* (channel: HostChannel, input: PlanInput) {
  const home = windowsHome(channel, input.platform);

  if (home !== null) return yield* planThisPc(home, input);
  const probe = yield* probeHost(channel.alias).pipe(Effect.provide(channel.ssh));
  const platform = platformFromUname(probe.os, probe.arch, probe.libc);

  const builds = yield* input.builds.forPlatform(platform, {
    build: input.trigger === "user",
    onBuild: input.onBuild,
  });

  const plan = planInstall(probe, builds, {
    trigger: input.trigger,
    approvedSha256: input.approved,
    // This Mac's own Daemon: a first install needs no approval (ADR 0041).
    trusted: channel.trusted,
  });

  const build = builds.find((b) => b.platform === platform);

  return {
    platform,
    plan,
    installedVersion: probe.installed?.version ?? null,
    bundledVersion: build?.version ?? null,
    size: sizeOf(build),
    windowsShell: probe.windowsShell ?? null,
  } satisfies Planned;
});

const planThisPc = Effect.fn("planThisPc")(function* (home: string, input: PlanInput) {
  const installed = yield* installedVersion(home, input.processes);

  const builds = yield* input.builds.forPlatform(WINDOWS_PLATFORM, {
    build: input.trigger === "user",
    onBuild: input.onBuild,
  });

  const build = builds.find((b) => b.platform === WINDOWS_PLATFORM);

  return {
    platform: WINDOWS_PLATFORM,
    plan: planWindowsLocal(installed, builds, input.trigger),
    installedVersion: installed,
    bundledVersion: build?.version ?? null,
    size: sizeOf(build),
    windowsShell: null,
  } satisfies Planned;
});

/** Get the build onto the Host (upload, or a download there or here), check it, and run `polaris install|upgrade`. */
export const applyWork = (
  channel: HostChannel,
  work: InstallWork,
  options: ApplyOptions = {},
  local: LocalOptions = {}
) => {
  const home = windowsHome(channel, local.platform);

  if (home !== null)
    return applyWindowsLocal(home, work, local.processes, options.replaceTask === true);

  return Effect.map(
    applyPlan(channel.alias, work, options).pipe(Effect.provide(channel.ssh)),
    (applied): InstallOutcome =>
      Match.value(applied).pipe(
        Match.tagsExhaustive({
          Installed: ({ version, report }) =>
            reportOutcome(report, { kind: "installed", version, from: null }),
          Upgraded: ({ from, version, report }) =>
            reportOutcome(report, { kind: "upgraded", version, from }),
        })
      )
  );
};

export class StartFailed extends Schema.TaggedError<StartFailed>()("StartFailed", {
  message: Schema.String,
}) {}

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

/**
 * `polaris install --json` with the installed build: idempotent, it (re)starts the service.
 * A Windows SSH Host (`windowsShell`) gets the PowerShell line, valid in either DefaultShell.
 */
export const startDaemon = Effect.fn("startDaemon")(function* (
  channel: HostChannel,
  local: LocalOptions = {},
  windowsShell: WindowsShell | null = null,
  replaceTask: boolean = false
) {
  const home = windowsHome(channel, local.platform);

  if (home !== null) return yield* startWindowsLocal(home, local.processes, replaceTask);

  const result = yield* channel.exec(
    windowsShell === null
      ? shScript('"$HOME/.polaris/bin/current/polaris" install --json')
      : startCommand(replaceTask)
  );

  const report = Option.getOrNull(decodeReport(result.stdout.trim().split("\n").at(-1) ?? ""));
  const conflict = taskConflictOf(report, { alias: channel.alias, step: "start" });

  if (conflict !== null) return yield* conflict;

  if (result.code === 0 && report?.ok === true) return;

  const message = Predicate.isString(report?.message)
    ? report.message
    : (result.stderr || result.stdout).trim();

  return yield* new StartFailed({ message: message || `exit ${result.code}` });
});

/** One line for a failure crossing into the install card. */
export const failureMessage = (error: { readonly message: string }): string =>
  error.message
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1) ?? error.message;
