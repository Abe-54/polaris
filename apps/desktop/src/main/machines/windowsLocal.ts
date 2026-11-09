/**
 * This PC's own Daemon on Windows: no shell and no upload. The app runs the `polaris.exe`
 * it bundles (`install`), or the installed one with the bundled path (`upgrade`), and reads
 * the installed version with `polaris.exe version`. Decisions: docs/adr/0062-the-desktop-app-checks-the-local-pipes-owner.md.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { installedPaths } from "@polaris/client";
import {
  backgroundUpgradeDue,
  compareVersions,
  type DaemonBuild,
  Delivery,
  InstallPlan,
  type InstallTrigger,
  type TaskConflict,
  taskConflictOf,
  upgradeDue,
  SshError,
  type SshResult,
} from "@polaris/client/install";
import { type ChildProcessApi, childProcesses } from "@polaris/client/process";
import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { InstallOutcome, InstallWork } from "./installFlow.ts";
import { reportOutcome } from "./views.ts";

export const WINDOWS_PLATFORM = "windows-x64";

export class WindowsLocalFailed extends Schema.TaggedError<WindowsLocalFailed>()(
  "WindowsLocalFailed",
  { step: Schema.String, message: Schema.String }
) {}

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Command {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly step: string;
  /** The home whose `.polaris` the command acts on, whatever `POLARIS_HOME` the app has. */
  readonly home: string;
}

/** Runs the command hidden, with no shell, and collects what it printed. */
const run = (processes: ChildProcessApi, { file, args, step, home }: Command) =>
  Effect.callback<Ran, WindowsLocalFailed>((resume) => {
    const env = { ...process.env, POLARIS_HOME: join(home, ".polaris") };
    const child = processes.spawn({ file, args, env, timeoutMs: 120_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on(
      "data",
      (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-8000))
    );
    child.on("error", (error) =>
      resume(Effect.fail(new WindowsLocalFailed({ step, message: `${file}: ${error.message}` })))
    );
    child.on("close", (code) => resume(Effect.succeed({ code, stdout, stderr })));
  });

const VERSION_LINE = /^polaris (\S+) (\S+)\s*$/m;

/** The installed Daemon's version (`polaris.exe version`), or null when none is installed. */
export const installedVersion = (
  home: string,
  processes: ChildProcessApi = childProcesses
): Effect.Effect<string | null, WindowsLocalFailed> => {
  const binary = installedPaths(home, "win32").binary;

  if (!existsSync(binary)) return Effect.succeed(null);

  return Effect.map(
    run(processes, { file: binary, args: ["version"], step: "version", home }),
    (ran) => VERSION_LINE.exec(ran.stdout)?.[1] ?? null
  );
};

/** What to do about this PC's Daemon: like `planInstall`, always trusted, and always an upload. */
export const planWindowsLocal = (
  installed: string | null,
  builds: ReadonlyArray<DaemonBuild>,
  trigger: InstallTrigger
): InstallPlan => {
  const build = builds.find((candidate) => candidate.platform === WINDOWS_PLATFORM);

  if (build === undefined || !build.bundled)
    return InstallPlan.MissingBuild({ platform: WINDOWS_PLATFORM });
  const delivery = Delivery.Upload();

  if (installed === null) return InstallPlan.Install({ build, delivery });
  const due = trigger === "background" ? backgroundUpgradeDue : upgradeDue;

  if (due(installed, build.version))
    return InstallPlan.Upgrade({ from: installed, build, delivery });

  if (compareVersions(installed, build.version) > 0)
    return InstallPlan.InstalledNewer({ installed, bundled: build.version });

  return InstallPlan.UpToDate({ version: build.version });
};

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

/** The JSON line `polaris.exe … --json` printed last, or why it failed. */
const reportOf = (
  ran: Ran,
  step: string
): Effect.Effect<Schema.JsonObject, WindowsLocalFailed | TaskConflict> => {
  const report = Option.getOrNull(decodeReport(ran.stdout.trim().split(/\r?\n/).at(-1) ?? ""));
  const conflict = taskConflictOf(report, { alias: "local", step });

  if (conflict !== null) return Effect.fail(conflict);

  if (ran.code === 0 && report?.ok === true) return Effect.succeed(report);

  const message = Predicate.isString(report?.message)
    ? report.message
    : (ran.stderr || ran.stdout).trim() || `exit ${ran.code}`;

  return Effect.fail(new WindowsLocalFailed({ step, message }));
};

/**
 * Installs the bundled build, or upgrades the installed Daemon to it; both restart the task.
 * `replaceTask` takes over a sign-in task another Polaris home holds (`TaskConflict`).
 */
export const applyWindowsLocal = (
  home: string,
  work: InstallWork,
  processes: ChildProcessApi = childProcesses,
  replaceTask = false
): Effect.Effect<InstallOutcome, WindowsLocalFailed | TaskConflict> => {
  const bundled = work.build.files[0]?.path ?? "";
  const sha = work.build.sha256;
  const takeOver = replaceTask ? ["--replace-task"] : [];

  return Match.value(work).pipe(
    Match.tagsExhaustive({
      Install: () =>
        run(processes, {
          file: bundled,
          args: ["install", "--json", "--sha256", sha, ...takeOver],
          step: "install",
          home,
        }).pipe(
          Effect.flatMap((ran) => reportOf(ran, "install")),
          Effect.map((report) =>
            reportOutcome(report, { kind: "installed", version: work.build.version, from: null })
          )
        ),
      Upgrade: ({ from }) =>
        run(processes, {
          file: installedPaths(home, "win32").binary,
          args: ["upgrade", bundled, "--json", "--sha256", sha, ...takeOver],
          step: "upgrade",
          home,
        }).pipe(
          Effect.flatMap((ran) => reportOf(ran, "upgrade")),
          Effect.map((report) =>
            reportOutcome(report, { kind: "upgraded", version: work.build.version, from })
          )
        ),
    })
  );
};

/**
 * Start daemon: the installed `polaris.exe install`, which (re)registers and runs the task.
 * `replaceTask` takes over a sign-in task another Polaris home holds (`TaskConflict`).
 */
export const startWindowsLocal = (
  home: string,
  processes: ChildProcessApi = childProcesses,
  replaceTask = false
): Effect.Effect<void, WindowsLocalFailed | TaskConflict> =>
  run(processes, {
    file: installedPaths(home, "win32").binary,
    args: ["install", "--json", ...(replaceTask ? ["--replace-task"] : [])],
    step: "start",
    home,
  }).pipe(
    Effect.flatMap((ran) => reportOf(ran, "start")),
    Effect.asVoid
  );

/** Runs this PC's installed `polaris.exe` with `args`, for Restart daemon's runner. */
export const runInstalled = (
  home: string,
  args: ReadonlyArray<string>,
  processes: ChildProcessApi = childProcesses
): Effect.Effect<SshResult, SshError> =>
  run(processes, { file: installedPaths(home, "win32").binary, args, step: "restart", home }).pipe(
    Effect.map((ran) => ({ code: ran.code ?? 1, stdout: ran.stdout, stderr: ran.stderr })),
    Effect.mapError(
      (error) => new SshError({ alias: "local", failure: "spawn", message: error.message })
    )
  );
