/**
 * `polaris install` / `polaris uninstall`: lay the binary out under
 * `~/.polaris/bin/<version>/polaris`, point `~/.polaris/bin/current` at it,
 * and register a user service (launchd LaunchAgent on macOS, systemd
 * `--user` unit on Linux, a scheduled task on Windows). No sudo or
 * administrator, ever. Every step is idempotent: running
 * install twice with the same binary changes nothing and restarts nothing.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { Effect, Match } from "effect";
import { defaultStateFile, stopAppServer } from "../harness/codex/AppServer.ts";
import { currentUserSid } from "../transport/windowsPipe/win32.ts";
import { CommandRunner } from "./CommandRunner.ts";
import {
  BUNDLE_FILE_NAMES,
  BUNDLE_FILES,
  type BundleFile,
  bundleSources,
  DAEMON_BUNDLE,
} from "./bundle.ts";
import { binaryNameFor, currentLinkFor, pointCurrent, readCurrent } from "./current.ts";
import { InstallError, TaskConflictError } from "./errors.ts";
import { activateLaunchd, type LaunchdTiming, unloadEverywhere } from "./launchd.ts";
import {
  LAUNCHD_LABEL,
  launchdPlist,
  type ServiceSpec,
  SUPERVISOR_MARKER,
  SYSTEMD_UNIT,
  supervisorScript,
  supervisorStartLine,
  systemdUnit,
} from "./templates.ts";
import {
  activateWindowsTask,
  removeWindowsTask,
  type WindowsTaskTarget,
} from "./windowsService.ts";
import { realProfileDirectory } from "./windowsProfile.ts";
import { taskXml, taskXmlBytes, windowsTaskName } from "./windowsTask.ts";

export { InstallError, TaskConflictError };

export type ServiceOs = "darwin" | "linux" | "win32";

/** Windows only: who the task runs as and where Windows lives. */
export interface WindowsServiceContext {
  /** The Task Scheduler task's name (`windowsTaskName`); tests use their own. */
  readonly task: string;
  readonly userSid: string;
  /** `%SystemRoot%`. */
  readonly systemRoot: string;
}

export interface InstallContext {
  readonly os: ServiceOs;
  /** `~/.polaris` (or `POLARIS_HOME`). */
  readonly polarisHome: string;
  /** The user's home directory, where `Library/LaunchAgents` or `.config/systemd` live. */
  readonly userHome: string;
  /** `$XDG_CONFIG_HOME`, when set (Linux). */
  readonly xdgConfigHome: string | null;
  readonly uid: number;
  readonly user: string;
  /** PATH for the service, so the Daemon finds Harnesses and git. */
  readonly path: string;
  /** The LaunchAgent's label (`dev.lux.polaris`); tests use their own. */
  readonly launchdLabel: string;
  readonly windows?: WindowsServiceContext;
}

const serviceOs = (platform: string): ServiceOs =>
  platform === "darwin" || platform === "win32" ? platform : "linux";

export const defaultInstallContext = (polarisHome: string): InstallContext => {
  const info = userInfo();
  const os = serviceOs(process.platform);

  const context: InstallContext = {
    os,
    polarisHome,
    userHome: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null,
    uid: info.uid,
    user: info.username,
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    launchdLabel: LAUNCHD_LABEL,
  };

  if (os !== "win32") return context;

  const windows: WindowsServiceContext = {
    task: windowsTaskName(info.username, polarisHome, realProfileDirectory()),
    userSid: currentUserSid(),
    systemRoot: process.env.SystemRoot ?? "C:\\Windows",
  };

  return { ...context, windows };
};

const windowsOf = (ctx: InstallContext): WindowsServiceContext => {
  if (ctx.windows === undefined) throw new Error("a Windows install needs InstallContext.windows");

  return ctx.windows;
};

const serviceFileOf = (ctx: InstallContext) => {
  if (ctx.os === "darwin")
    return join(ctx.userHome, "Library", "LaunchAgents", `${ctx.launchdLabel}.plist`);

  // The task's definition lives in Task Scheduler; this copy is what install compares.
  if (ctx.os === "win32") return join(ctx.polarisHome, "polaris-task.xml");

  return join(ctx.xdgConfigHome ?? join(ctx.userHome, ".config"), "systemd", "user", SYSTEMD_UNIT);
};

export const layout = (ctx: InstallContext, version?: string) => {
  const bin = join(ctx.polarisHome, "bin");
  const binary = binaryNameFor(ctx.os);

  return {
    bin,
    current: join(bin, "current"),
    launcher: join(bin, "current", binary),
    versionDir: version === undefined ? null : join(bin, version),
    installed: version === undefined ? null : join(bin, version, binary),
    logs: join(ctx.polarisHome, "logs"),
    /** The fallback supervisor on Linux Hosts without systemd --user. */
    supervisor: join(bin, "polaris-supervise"),
    serviceFile: serviceFileOf(ctx),
  };
};

export const serviceSpec = (ctx: InstallContext): ServiceSpec => {
  const paths = layout(ctx);

  return {
    program: paths.launcher,
    args: ["serve"],
    home: ctx.polarisHome,
    logDir: paths.logs,
    env: { PATH: ctx.path },
  };
};

export const renderServiceFile = (ctx: InstallContext): string => {
  if (ctx.os === "darwin") return launchdPlist(serviceSpec(ctx), ctx.launchdLabel);

  if (ctx.os === "win32") {
    const windows = windowsOf(ctx);

    return taskXml({
      userSid: windows.userSid,
      polarisHome: ctx.polarisHome,
      systemRoot: windows.systemRoot,
    });
  }

  return systemdUnit(serviceSpec(ctx));
};

export const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export type LingerStatus = "enabled" | "already-enabled" | "needs-admin" | "not-applicable";

/** What keeps the Daemon running: launchd, systemd --user, Polaris' own fallback supervisor, or a Windows scheduled task. */
export type Supervisor = "launchd" | "systemd" | "fallback" | "task-scheduler";

/** How the fallback supervisor comes back after a reboot or logout. */
export type Autostart = "cron" | "profile";

export type CrontabAccess = "available" | "missing" | "denied";

export interface LinuxServiceProbe {
  /** `systemctl --user` reaches a user manager (a user bus exists). */
  readonly userSystemd: boolean;
  readonly crontab: CrontabAccess;
}

/**
 * Pure: which supervisor a Linux Host gets. systemd --user whenever it
 * answers; otherwise the fallback supervisor, started at boot by cron
 * `@reboot` when the user may edit their crontab, and at login by the shell
 * profile always (it is single-instance, so both are harmless together).
 */
export const planLinuxService = (
  probe: LinuxServiceProbe
): { readonly supervisor: "systemd" | "fallback"; readonly autostart: ReadonlyArray<Autostart> } =>
  probe.userSystemd
    ? { supervisor: "systemd", autostart: [] }
    : {
        supervisor: "fallback",
        autostart: probe.crontab === "available" ? ["cron", "profile"] : ["profile"],
      };

export interface InstallReport {
  readonly version: string;
  readonly binary: string;
  readonly sha256: string;
  readonly binaryChanged: boolean;
  readonly serviceFile: string;
  readonly serviceFileChanged: boolean;
  /** The launchd domain (`gui/501`, `user/501`) or `systemd --user`. */
  readonly serviceDomain: string;
  readonly restarted: boolean;
  readonly linger: LingerStatus;
  /** What keeps the Daemon running; the Client shows `fallback` with `notes`. */
  readonly supervisor: Supervisor;
  /** Fallback only: what starts it again after a reboot (cron) or at login (profile). */
  readonly autostart: ReadonlyArray<Autostart>;
  readonly notes: ReadonlyArray<string>;
}

const fsStep = <A>(step: string, f: () => A) =>
  Effect.try({ try: f, catch: (error) => new InstallError({ step, message: String(error) }) });

/**
 * Copies `source` into place atomically; false if an identical file is already there.
 * The copy itself must hash to `sha256`, so what lands is what was checked.
 */
const placeFile = (source: string, target: string, sha256: string, mode: number) =>
  fsStep(`copy ${basename(target)}`, () => {
    if (source === target) return false;

    if (existsSync(target) && sha256File(target) === sha256) return false;
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}`;
    copyFileSync(source, temp);

    if (sha256File(temp) !== sha256) {
      rmSync(temp, { force: true });
      throw new Error(`${source} does not have the SHA-256 ${sha256}`);
    }

    chmodSync(temp, mode);
    renameSync(temp, target);

    return true;
  });

/** Executables that travel beside `polaris` in a build (`scripts/build-daemon.ts`) and are installed with it. */
export const SIBLING_EXECUTABLES = ["betterleaks"] as const;

const EXECUTABLE_BUNDLE_FILES: ReadonlySet<BundleFile> = new Set(["polaris", "betterleaks"]);

const isSymlink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Points `link` at the relative `target` by renaming a fresh symlink over it; false if it did. */
const linkTo = (link: string, target: string) =>
  fsStep(`link ${basename(link)}`, () => {
    if (isSymlink(link) && readlinkSync(link) === target) return false;
    const temp = `${link}.tmp-${process.pid}`;
    rmSync(temp, { force: true });
    symlinkSync(target, temp);
    renameSync(temp, link);

    return true;
  });

/**
 * macOS: places a bundled build's files in `bin/<version>/PolarisDaemon.app` (`bundle.ts`),
 * byte for byte so its signature holds, and links `bin/<version>/polaris` to its executable.
 */
const stageBundle = Effect.fn("stageBundle")(function* (
  ctx: InstallContext,
  options: InstallOptions,
  sources: Record<BundleFile, string>
) {
  const versionDir = layout(ctx, options.version).versionDir!;
  const bundle = join(versionDir, DAEMON_BUNDLE);

  const sha256 =
    options.sha256 ?? (yield* fsStep("hash binary", () => sha256File(sources.polaris)));

  let changed = false;

  for (const name of BUNDLE_FILE_NAMES) {
    const source = sources[name];

    if (!existsSync(source)) continue;

    const hash =
      name === "polaris" ? sha256 : yield* fsStep(`hash ${name}`, () => sha256File(source));

    const mode = EXECUTABLE_BUNDLE_FILES.has(name) ? 0o755 : 0o644;
    const placed = yield* placeFile(source, join(bundle, BUNDLE_FILES[name]), hash, mode);
    changed = changed || placed;
  }

  const link = join(versionDir, binaryNameFor(ctx.os));
  const linked = yield* linkTo(link, join(DAEMON_BUNDLE, BUNDLE_FILES.polaris));

  return { path: join(bundle, BUNDLE_FILES.polaris), sha256, changed: changed || linked };
});

/**
 * Copies `source` to `~/.polaris/bin/<version>/polaris` (a no-op if an
 * identical file is there), and each sibling executable found next to
 * `source` beside it. Native libraries such as fff's and ast-grep's are
 * embedded by `bun build --compile`; Betterleaks is a separate Go binary.
 * A macOS build that is a bundle is placed as one (`stageBundle`).
 */
export const stageBinary = Effect.fn("stageBinary")(function* (
  ctx: InstallContext,
  options: InstallOptions
) {
  const sources = ctx.os === "darwin" ? bundleSources(options.source) : null;

  if (sources !== null) return yield* stageBundle(ctx, options, sources);
  const path = layout(ctx, options.version).installed!;
  const sha256 = options.sha256 ?? (yield* fsStep("hash binary", () => sha256File(options.source)));

  // A flat copy replaces the link a bundled install of this version left.
  if (isSymlink(path)) yield* fsStep("unlink polaris", () => rmSync(path));
  let changed = yield* placeFile(options.source, path, sha256, 0o755);

  for (const name of SIBLING_EXECUTABLES) {
    const sibling = join(dirname(options.source), name);

    if (!existsSync(sibling)) continue;
    const siblingSha = yield* fsStep(`hash ${name}`, () => sha256File(sibling));
    const placed = yield* placeFile(sibling, join(dirname(path), name), siblingSha, 0o755);
    changed = changed || placed;
  }

  return { path, sha256, changed };
});

/** Points `current` at `version` (`current.ts`); false if it already did. */
export const pointCurrentAt = (ctx: InstallContext, version: string) =>
  fsStep("link current", () => pointCurrent(layout(ctx).bin, version, currentLinkFor(ctx.os)));

/** The bytes a service file is written as: `schtasks /XML` reads UTF-16. */
const serviceFileBytes = (ctx: InstallContext, content: string): Uint8Array =>
  ctx.os === "win32" ? taskXmlBytes(content) : Buffer.from(content, "utf8");

const writeIfChanged = (path: string, bytes: Uint8Array, mode = 0o644) =>
  fsStep("write service file", () => {
    if (existsSync(path) && readFileSync(path).equals(bytes)) return false;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { mode });
    chmodSync(path, mode);

    return true;
  });

const run = Effect.fnUntraced(function* (
  argv: ReadonlyArray<string>,
  options?: { readonly stdin?: string }
) {
  const runner = yield* CommandRunner;

  return yield* runner.run(argv, options);
});

const runOrFail = Effect.fnUntraced(function* (step: string, argv: ReadonlyArray<string>) {
  const result = yield* run(argv);

  if (result.code !== 0) {
    return yield* new InstallError({
      step,
      message: `\`${argv.join(" ")}\` exited ${result.code}: ${(result.stderr || result.stdout).trim()}`,
    });
  }

  return result;
});

// ── Linux without systemd --user ───────────────────────────────────────────

/** Probe the Host's service options; never fails. */
export const probeLinuxService = Effect.fnUntraced(function* () {
  const systemd = yield* run(["systemctl", "--user", "show-environment"]);
  const crontab = yield* run(["crontab", "-l"]);

  const access: CrontabAccess =
    crontab.code === 0 || /no crontab/i.test(crontab.stderr)
      ? "available"
      : crontab.code === 127
        ? "missing"
        : "denied";

  return {
    probe: { userSystemd: systemd.code === 0, crontab: access } satisfies LinuxServiceProbe,
    systemdError:
      systemd.code === 127
        ? "systemctl is not installed"
        : (systemd.stderr || systemd.stdout).trim(),
    crontab: crontab.code === 0 ? crontab.stdout : "",
  };
});

/** `lines` without Polaris' marked lines, plus `line` (when given), newline-terminated. */
const withMarkedLine = (content: string, line: string | null): string => {
  const kept = content.split("\n").filter((l) => l !== "" && !l.includes(SUPERVISOR_MARKER));
  const all = line === null ? kept : [...kept, line];

  return all.length === 0 ? "" : `${all.join("\n")}\n`;
};

/** The login profiles to hook: `~/.profile`, plus bash's own if they exist (bash reads only the first). */
const profileFiles = (ctx: InstallContext): Array<string> => [
  join(ctx.userHome, ".profile"),
  ...[".bash_profile", ".bash_login"].flatMap((name) => {
    const path = join(ctx.userHome, name);

    return existsSync(path) ? [path] : [];
  }),
];

const editProfiles = (ctx: InstallContext, line: string | null) =>
  fsStep("edit login profile", () => {
    for (const file of profileFiles(ctx)) {
      const before = existsSync(file) ? readFileSync(file, "utf8") : null;

      if (before === null && line === null) continue;

      const kept = (before ?? "")
        .split("\n")
        .filter((l) => !l.includes(SUPERVISOR_MARKER))
        .join("\n")
        .replace(/\n*$/, "");

      const after = line === null ? `${kept}\n` : `${kept}${kept === "" ? "" : "\n"}${line}\n`;

      if (after !== before) writeFileSync(file, after);
    }
  });

const pidFromFile = (path: string): number | null => {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());

    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);

    return pid;
  } catch {
    return null;
  }
};

/** SIGTERM `pid` and wait up to 5 s for it to go. */
const terminate = (pid: number) =>
  Effect.promise(async () => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }

    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }

      await Bun.sleep(50);
    }
  });

const activateFallback = Effect.fnUntraced(function* (
  ctx: InstallContext,
  changed: { readonly binary: boolean; readonly serviceFile: boolean },
  plan: { readonly autostart: ReadonlyArray<Autostart> },
  found: { readonly systemdError: string; readonly crontab: string }
) {
  const paths = layout(ctx);

  const notes: Array<string> = [
    `No systemd user bus on this Host (${found.systemdError || "systemctl --user failed"}), so Polaris runs under its own supervisor (${paths.supervisor}). It restarts the Daemon if it exits.`,
  ];

  if (plan.autostart.includes("cron")) {
    const next = withMarkedLine(found.crontab, supervisorStartLine(paths.supervisor, "cron"));

    if (next !== found.crontab) {
      const written = yield* run(["crontab", "-"], { stdin: next });

      if (written.code !== 0) {
        return yield* new InstallError({
          step: "edit crontab",
          message: `crontab - exited ${written.code}: ${written.stderr.trim()}`,
        });
      }
    }

    notes.push("It starts at boot through cron @reboot, if a cron daemon runs at boot.");
  } else {
    notes.push(
      "It does not start at boot (no usable crontab); it starts at your next login, or when the Client reinstalls."
    );
  }

  yield* editProfiles(ctx, supervisorStartLine(paths.supervisor, "profile"));
  // A new binary: stop the running Daemon; the supervisor restarts it on `current`.
  const daemon = pidFromFile(join(ctx.polarisHome, "daemon.pid"));
  const restart = daemon !== null && (changed.binary || changed.serviceFile);

  if (restart) yield* terminate(daemon);
  yield* runOrFail("start supervisor", [paths.supervisor]);

  return {
    domain: "polaris-supervisor",
    restarted: restart,
    linger: "not-applicable" as const,
    notes,
  };
});

/** Stop the fallback supervisor (and its Daemon) and remove its autostart lines. */
const removeFallback = Effect.fnUntraced(function* (ctx: InstallContext) {
  const supervisor = pidFromFile(join(ctx.polarisHome, "supervisor.pid"));

  if (supervisor !== null) yield* terminate(supervisor);
  const crontab = yield* run(["crontab", "-l"]);

  if (crontab.code === 0 && crontab.stdout.includes(SUPERVISOR_MARKER)) {
    yield* run(["crontab", "-"], { stdin: withMarkedLine(crontab.stdout, null) });
  }

  yield* editProfiles(ctx, null);

  return supervisor !== null;
});

/**
 * Enable lingering so the user manager (and the Daemon) survives logout and
 * starts at boot. Allowed for oneself on most distributions when the session
 * is local; over SSH polkit often wants an administrator.
 */
const enableLinger = Effect.fnUntraced(function* (ctx: InstallContext) {
  const shown = yield* run(["loginctl", "show-user", ctx.user, "--property=Linger", "--value"]);

  if (shown.code === 0 && shown.stdout.trim() === "yes") return "already-enabled" as const;
  const enabled = yield* run(["loginctl", "enable-linger", ctx.user]);

  return enabled.code === 0 ? ("enabled" as const) : ("needs-admin" as const);
});

const activateSystemd = Effect.fnUntraced(function* (
  ctx: InstallContext,
  changed: { readonly binary: boolean; readonly serviceFile: boolean }
) {
  const notes: Array<string> = [];
  const systemctl = (...args: Array<string>) => ["systemctl", "--user", ...args];

  if (changed.serviceFile) yield* runOrFail("reload units", systemctl("daemon-reload"));
  const active = yield* run(systemctl("is-active", "--quiet", SYSTEMD_UNIT));
  yield* runOrFail("enable service", systemctl("enable", SYSTEMD_UNIT));
  const restart = active.code === 0 && (changed.binary || changed.serviceFile);
  yield* runOrFail("start service", systemctl(restart ? "restart" : "start", SYSTEMD_UNIT));
  const linger = yield* enableLinger(ctx);

  if (linger === "needs-admin") {
    notes.push(
      `Lingering is off, so the Daemon stops when ${ctx.user} logs out. An administrator can run: sudo loginctl enable-linger ${ctx.user}`
    );
  }

  return { domain: "systemd --user", restarted: restart, linger, notes };
});

/** Windows: this home's task, as `windowsService.ts` drives it. */
const windowsTarget = (ctx: InstallContext): WindowsTaskTarget => ({
  task: windowsOf(ctx).task,
  home: ctx.polarisHome,
  definition: layout(ctx).serviceFile,
  userSid: windowsOf(ctx).userSid,
  systemRoot: windowsOf(ctx).systemRoot,
});

/**
 * A running executable can't be deleted on Windows, but it can be renamed: move
 * this process's own binary out of `bin` (into the temp directory) so `bin` can go.
 */
const moveSelfOutOf = (bin: string) => {
  const inside = relative(bin, process.execPath);

  if (process.platform !== "win32" || inside.startsWith("..") || inside === process.execPath)
    return;

  // Earlier uninstalls' copies, whose processes have exited by now.
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(UNINSTALLED_PREFIX)) rmSync(join(tmpdir(), name), { force: true });
  }

  renameSync(process.execPath, join(tmpdir(), `${UNINSTALLED_PREFIX}${process.pid}.exe`));
};

const UNINSTALLED_PREFIX = "polaris-uninstalled-";

export interface InstallOptions {
  /** The compiled `polaris` binary to install (normally this process's own executable). */
  readonly source: string;
  readonly version: string;
  /** The SHA-256 the Client verified; the installed copy must match it. */
  readonly sha256?: string | undefined;
  /** macOS: how long to wait for a booted-out Daemon (tests shorten it). */
  readonly launchdTiming?: LaunchdTiming;
  /** Windows: take over this home's task even when it runs another installed home. */
  readonly replaceTask?: boolean;
  /** Windows: stop and start the task's Daemon even when nothing changed (Restart daemon). */
  readonly restart?: boolean;
}

/** What `current` and the service file were before an install, to roll back to. */
interface PreviousInstall {
  readonly current: string | null;
  readonly serviceFile: Uint8Array | null;
}

const readPrevious = (ctx: InstallContext) =>
  fsStep("read previous install", (): PreviousInstall => {
    const paths = layout(ctx);
    const serviceFile = existsSync(paths.serviceFile) ? readFileSync(paths.serviceFile) : null;

    return { current: readCurrent(paths.bin), serviceFile };
  });

/** Puts `previous` back; true if anything changed. */
const restorePrevious = (ctx: InstallContext, previous: PreviousInstall) =>
  Effect.gen(function* () {
    const relinked =
      previous.current === null ? false : yield* pointCurrentAt(ctx, previous.current);

    const { serviceFile } = layout(ctx);

    const rewritten =
      previous.serviceFile === null
        ? yield* fsStep("remove service file", () => {
            const existed = existsSync(serviceFile);
            rmSync(serviceFile, { force: true });

            return existed;
          })
        : yield* writeIfChanged(serviceFile, previous.serviceFile);

    return relinked || rewritten;
  });

export const install = Effect.fn("install")(function* (
  ctx: InstallContext,
  options: InstallOptions
): Effect.fn.Return<InstallReport, InstallError | TaskConflictError, CommandRunner> {
  const paths = layout(ctx, options.version);
  yield* fsStep("create directories", () =>
    mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  );
  const previous = yield* readPrevious(ctx);
  const staged = yield* stageBinary(ctx, options);
  const sha256 = staged.sha256;
  const binaryChanged = staged.changed;
  const currentChanged = yield* pointCurrentAt(ctx, options.version);
  const linux = ctx.os === "linux" ? yield* probeLinuxService() : null;
  const plan = linux === null ? null : planLinuxService(linux.probe);
  const fallback = plan?.supervisor === "fallback";
  const serviceFile = fallback ? paths.supervisor : paths.serviceFile;

  const serviceFileChanged = fallback
    ? yield* writeIfChanged(serviceFile, Buffer.from(supervisorScript(serviceSpec(ctx))), 0o755)
    : yield* writeIfChanged(serviceFile, serviceFileBytes(ctx, renderServiceFile(ctx)));

  const changed = { binary: binaryChanged || currentChanged, serviceFile: serviceFileChanged };

  const activation = Match.value(ctx.os).pipe(
    Match.when("darwin", () =>
      activateLaunchd(
        { uid: ctx.uid, label: ctx.launchdLabel, serviceFile: paths.serviceFile },
        changed,
        restorePrevious(ctx, previous),
        options.launchdTiming
      ).pipe(Effect.map((done) => ({ ...done, linger: "not-applicable" as const })))
    ),
    Match.when("win32", () =>
      activateWindowsTask(
        windowsTarget(ctx),
        changed,
        options.version,
        options.replaceTask === true,
        options.restart === true
      )
    ),
    Match.orElse(() =>
      fallback ? activateFallback(ctx, changed, plan, linux!) : activateSystemd(ctx, changed)
    )
  );

  const done = yield* activation;

  const supervisor: Supervisor = Match.value(ctx.os).pipe(
    Match.when("darwin", (): Supervisor => "launchd"),
    Match.when("win32", (): Supervisor => "task-scheduler"),
    Match.orElse((): Supervisor => (fallback ? "fallback" : "systemd"))
  );

  return {
    version: options.version,
    binary: staged.path,
    sha256,
    binaryChanged: changed.binary,
    serviceFile,
    serviceFileChanged,
    serviceDomain: done.domain,
    restarted: done.restarted,
    linger: done.linger,
    supervisor,
    autostart: fallback ? plan.autostart : [],
    notes: done.notes,
  };
});

export interface UninstallReport {
  readonly serviceFileRemoved: boolean;
  /** PID of the shared Codex app-server that was stopped, if one was running. */
  readonly codexAppServerStopped: number | null;
  /** Linux: the fallback supervisor (and its Daemon) was running and was stopped; Windows: the task's Daemon. */
  readonly supervisorStopped: boolean;
  readonly binariesRemoved: boolean;
  readonly purged: boolean;
  /** Windows: this home's task name, left registered because it runs another Polaris home. */
  readonly keptTask: string | null;
}

/**
 * Stop and remove the user service and installed binaries. State (the event
 * store, logs, staging) stays unless `purge`, so a reinstall picks up where
 * it left off.
 */
export const uninstall = Effect.fn("uninstall")(function* (
  ctx: InstallContext,
  options: { readonly purge: boolean }
): Effect.fn.Return<UninstallReport, InstallError, CommandRunner> {
  const paths = layout(ctx);
  let supervisorStopped = false;
  let keptTask: string | null = null;

  if (ctx.os === "darwin") {
    yield* unloadEverywhere({ uid: ctx.uid, label: ctx.launchdLabel });
  } else if (ctx.os === "win32") {
    const removed = yield* removeWindowsTask(windowsTarget(ctx));
    supervisorStopped = removed.stopped;
    keptTask = removed.keptTask;
  } else {
    yield* run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
    supervisorStopped = yield* removeFallback(ctx);
  }

  // The shared Codex app-server outlives the Daemon on purpose; uninstall ends it.
  const appServer = yield* stopAppServer({
    stateFile: defaultStateFile(join(ctx.polarisHome, "codex.sock")),
    socketPath: join(ctx.polarisHome, "codex.sock"),
  });

  const serviceFileRemoved = yield* fsStep("remove service file", () => {
    const existed = existsSync(paths.serviceFile);
    rmSync(paths.serviceFile, { force: true });

    return existed;
  });

  if (ctx.os === "linux" && serviceFileRemoved) {
    yield* run(["systemctl", "--user", "daemon-reload"]);
  }

  const binariesRemoved = yield* fsStep("remove binaries", () => {
    const existed = existsSync(paths.bin);
    moveSelfOutOf(paths.bin);
    rmSync(options.purge ? ctx.polarisHome : paths.bin, { recursive: true, force: true });

    return existed;
  });

  return {
    serviceFileRemoved,
    codexAppServerStopped: appServer.stopped,
    supervisorStopped,
    binariesRemoved,
    purged: options.purge,
    keptTask,
  };
});
