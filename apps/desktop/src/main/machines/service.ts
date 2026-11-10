/**
 * `Machines`: the Hosts in Settings. Adds and removes remote Hosts by
 * `~/.ssh/config` alias, runs each one's install flow (probe, one-time
 * approval, install or upgrade), switches the local Host, and publishes the
 * Settings rows. A background check (a reconnect) never installs.
 */
import { existsSync } from "node:fs";
import { installedPaths } from "@polaris/client";
import type { HostInfo } from "@polaris/protocol";
import { HostAccess, type HostChannel } from "@polaris/client/access";
import {
  buildPlatformOf,
  type DownloadBuild,
  InstallPlan,
  type InstallTrigger,
  SshError,
  TaskConflict,
  type WindowsShell,
} from "@polaris/client/install";
import type { ChildProcessApi } from "@polaris/client/process";
import { WslDiscovery } from "@polaris/client/wsl";
import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import type { MachineView, SshAliasView, WslDistrosView } from "../../shared/api.ts";
import { clientCopy } from "../../shared/clientCopy.ts";
import { HostDirectory, LOCAL_HOST_KEY, localEntry, remoteEntry } from "../hosts.ts";
import { LocalHost, localTarget } from "../local/index.ts";
import type { RemoteHostSetting, Settings } from "../settings.ts";
import type { Approvals } from "./approvals.ts";
import type { DaemonBuilds } from "./builds.ts";
import { deliveryActivity } from "./delivery.ts";
import {
  type InstallEvent,
  type InstallProblem,
  type InstallWork,
  initialInstall,
  isStartWork,
  stepInstall,
} from "./installFlow.ts";
import { channelActivity, unmanagedLocal, unsupportedMessage } from "./channels.ts";
import { applyWork, failureMessage, planFor, startDaemon } from "./remote.ts";
import { previewOver, restartOver } from "./restart.ts";
import type { RestartDaemonResult, RestartPreviewView } from "../../shared/restart.ts";
import { backgroundCheckKey, type InstallRecord, localUpgradeKey, machineViews } from "./views.ts";
import { type UpdateFacts, updatePolicy } from "./updateFacts.ts";
import { wslDistrosView } from "./wsl.ts";
import type { DaemonUpdateProgress, DaemonUpdateResult } from "../../shared/daemonUpdates.ts";

export class MachineError extends Schema.TaggedError<MachineError>()("MachineError", {
  message: Schema.String,
}) {}

export interface SettingsStore {
  readonly get: () => Settings;
  readonly update: (change: (settings: Settings) => Settings) => void;
}

export interface MachinesInput {
  readonly platform?: NodeJS.Platform | undefined;
  readonly settings: SettingsStore;
  readonly approvals: Approvals;
  readonly builds: DaemonBuilds;
  /** Downloads a build this app doesn't bundle, for a Host that can't download it itself. */
  readonly download?: DownloadBuild | undefined;
  /** Sent with downloads for the site's telemetry. */
  readonly clientVersion?: string | undefined;
  readonly aliases: () => ReadonlyArray<SshAliasView>;
  /** Opens a terminal window on this Client running `argv`. */
  readonly openTerminal: (argv: ReadonlyArray<string>) => Promise<void>;
  /** The WSL distros on this machine (Windows), for "Add a host". */
  readonly discoverWsl?: Effect.Effect<WslDiscovery>;
  /** Runs this PC's `polaris.exe` on a Windows Client; tests script it. */
  readonly processes?: ChildProcessApi | undefined;
}

export interface AddMachine {
  /** Absent means ssh; "wsl" adds the distro named by `alias`. */
  readonly kind?: "ssh" | "wsl";
  readonly alias: string;
  readonly label: string;
  readonly colour: string | null;
  readonly forwardAgent: boolean;
}

export interface MachinePatch {
  readonly label?: string;
  readonly colour?: string | null;
  readonly forwardAgent?: boolean;
  readonly remoteCommand?: string | null;
}

type Failure = { readonly message: string };

const installsAnew = (plan: InstallPlan) =>
  Predicate.isTagged(plan, "NeedsApproval") || Predicate.isTagged(plan, "Install");

/** The build a connected Host runs (`linux-arm64-musl`), from its `hello`; null before one. */
const helloBuildPlatform = (host: HostInfo | null | undefined) =>
  host === null || host === undefined ? null : buildPlatformOf(host);

const fail = (message: string) => Effect.fail(new MachineError({ message }));

const asMachineError = (error: Failure) => new MachineError({ message: failureMessage(error) });

type MutableSetting = { -readonly [K in keyof RemoteHostSetting]: RemoteHostSetting[K] };

/** Applies a patch; a null colour or an empty remote command removes the setting. */
const patched = (remote: RemoteHostSetting, patch: MachinePatch): RemoteHostSetting => {
  const { remoteCommand, colour, ...rest } = { ...remote, ...patch };
  const next: MutableSetting = rest;
  const line = remoteCommand?.trim() ?? "";

  if (colour !== null && colour !== undefined) next.colour = colour;

  if (line !== "") next.remoteCommand = line;

  return next;
};

export class Machines extends Context.Service<
  Machines,
  {
    readonly views: SubscriptionRef.SubscriptionRef<ReadonlyArray<MachineView>>;
    readonly sshAliases: Effect.Effect<ReadonlyArray<SshAliasView>>;
    /** The WSL distros on this machine; `unsupported` off Windows. */
    readonly wslDistros: Effect.Effect<WslDistrosView>;
    readonly add: (input: AddMachine) => Effect.Effect<string, MachineError>;
    readonly update: (key: string, patch: MachinePatch) => Effect.Effect<void, MachineError>;
    readonly remove: (key: string) => Effect.Effect<void, MachineError>;
    /** The user asked: probe and plan, and install an approved build. */
    readonly check: (key: string) => Effect.Effect<void, MachineError>;
    readonly updateDaemon: (key: string) => Effect.Effect<void, MachineError>;
    readonly setKeepDaemonsUpToDate: (enabled: boolean) => Effect.Effect<void>;
    readonly setDaemonUpdateOverride: (
      key: string,
      enabled: boolean | null
    ) => Effect.Effect<void, MachineError>;
    readonly approve: (key: string, sha256: string) => Effect.Effect<void, MachineError>;
    readonly dismiss: (key: string) => Effect.Effect<void, MachineError>;
    /** The user confirmed: rerun the install a held sign-in task stopped, with `--replace-task`. */
    readonly takeOverTask: (key: string) => Effect.Effect<void, MachineError>;
    readonly startDaemon: (key: string) => Effect.Effect<void, MachineError>;
    /** Restart daemon: the Host's service manager restarts it (ADR 0087). */
    readonly restartDaemon: (key: string) => Effect.Effect<RestartDaemonResult, MachineError>;
    readonly restartPreview: (key: string) => Effect.Effect<RestartPreviewView, MachineError>;
    readonly setLocalEnabled: (enabled: boolean) => Effect.Effect<void, MachineError>;
    readonly openSsh: (key: string) => Effect.Effect<void, MachineError>;
  }
>()("polaris/desktop/Machines") {
  static readonly layer = (input: MachinesInput) => Layer.effect(Machines, makeMachines(input));
}

const makeMachines = Effect.fnUntraced(function* (input: MachinesInput) {
  const local = yield* LocalHost;

  /** The home of the installed Daemon serving the local Host, so it upgrades like a remote one. */
  const localHome = Effect.map(local.current, (daemon) =>
    Option.match(daemon, { onNone: () => null, onSome: (found) => found.installedHome })
  );

  const copy = clientCopy(input.platform);
  const dir = yield* HostDirectory;
  const access = yield* HostAccess;
  const scope = yield* Effect.scope;
  const installs = new Map<string, InstallRecord>();
  const work = new Map<string, Fiber.Fiber<void>>();
  const updates = new Map<string, UpdateFacts>();
  const progressChanges = yield* Queue.unbounded<void>();
  const views = yield* SubscriptionRef.make<ReadonlyArray<MachineView>>([]);
  let aliases = input.aliases();

  let bundledBuilds = yield* input.builds
    .forPlatform(null, { build: false, onBuild: Effect.void })
    .pipe(Effect.orElseSucceed(() => []));

  let bundled = bundledBuilds[0]?.version ?? null;

  const publish = Effect.gen(function* () {
    const hosts = yield* SubscriptionRef.get(dir.views);
    const home = yield* localHome;

    yield* SubscriptionRef.set(
      views,
      machineViews({
        settings: input.settings.get(),
        hosts,
        installs,
        aliases,
        updates,
        bundledVersion: bundled,
        bundledVersions: new Map(bundledBuilds.map((b) => [b.platform, b.version])),
        localManaged: home !== null,
        localSupported: local.supported,
        localLabel: local.label,
      })
    );
  });

  const remoteSetting = (key: string) =>
    (input.settings.get().hosts ?? []).find((h) => h.alias === key);

  const requireRemote = (key: string) => {
    const remote = remoteSetting(key);

    return remote === undefined ? fail(`no remote host "${key}"`) : Effect.succeed(remote);
  };

  /** The Host a key names: the local Host's Daemon, or a remote one from the settings. */
  const targetOf = (key: string) => {
    if (key !== LOCAL_HOST_KEY) return Effect.map(requireRemote(key), (r) => remoteEntry(r).target);

    if (!local.supported) return fail(copy.localHostUnsupported);

    return Effect.flatMap(local.current, (daemon) =>
      Option.match(daemon, {
        onNone: () => fail(unmanagedLocal(copy)),
        onSome: (found) => Effect.succeed(localTarget(found)),
      })
    );
  };

  /** How the Client acts on the Host: ssh, wsl.exe, or a local shell for this Mac's installed Daemon. */
  const channelFor = (key: string) =>
    targetOf(key).pipe(
      Effect.flatMap(access.channel),
      Effect.catchTag("HostActionUnsupported", (error) => fail(unsupportedMessage(error, copy)))
    );

  /** Waits for this Mac's Daemon to listen after an install or start. */
  const localListening = (home: string | null) =>
    home === null
      ? Effect.void
      : local
          .listening(home)
          .pipe(Effect.mapError((error) => new MachineError({ message: error.message })));

  const record = (key: string): InstallRecord =>
    installs.get(key) ?? { snapshot: initialInstall(), activity: null, offerSize: null };

  const step = (key: string, event: InstallEvent, activity: string | null = null) =>
    Effect.suspend(() => {
      const previous = record(key);
      const snapshot = stepInstall(previous.snapshot, event);

      if (snapshot === previous.snapshot) return Effect.succeed(snapshot);
      installs.set(key, { ...previous, snapshot, activity });

      return Effect.as(publish, snapshot);
    });

  const setRecord = (key: string, patch: Partial<InstallRecord>) =>
    Effect.suspend(() => {
      installs.set(key, { ...record(key), ...patch });

      return publish;
    });

  const updateFacts = (key: string, patch: Partial<UpdateFacts>) =>
    Effect.gen(function* () {
      const hosts = yield* SubscriptionRef.get(dir.views);
      const host = hosts.find((h) => h.key === key);
      const previous = updates.get(key);
      updates.set(key, {
        platform: helloBuildPlatform(host?.status.host),
        installedVersion: host?.status.host?.daemonVersion ?? null,
        bundledVersion: bundled,
        epoch: host?.status.epoch ?? 0,
        progress: null,
        lastUpdate: input.settings.get().daemonUpdates?.[key] ?? null,
        ...previous,
        ...patch,
      });
      yield* publish;
    });

  const finishUpdate = (key: string, result: DaemonUpdateResult) =>
    Effect.gen(function* () {
      input.settings.update((s) => ({
        ...s,
        daemonUpdates: { ...s.daemonUpdates, [key]: result },
      }));
      const progress = updates.get(key)?.progress;
      yield* updateFacts(key, {
        lastUpdate: result,
        installedVersion:
          result.problem === null ? result.version : (updates.get(key)?.installedVersion ?? null),
        progress: {
          stage: result.problem === null ? "done" : "failed",
          bytes: progress?.bytes ?? 0,
          total: progress?.total ?? 0,
        },
      });
    });

  const progress = (key: string) => (value: DaemonUpdateProgress) => {
    const previous = updates.get(key);

    if (previous === undefined) return;
    updates.set(key, { ...previous, progress: value });
    Queue.offerUnsafe(progressChanges, undefined);
  };

  yield* Stream.fromQueue(progressChanges).pipe(
    Stream.runForEach(() => publish),
    Effect.forkIn(scope)
  );

  const retryConnection = (key: string) =>
    dir.connection(key).pipe(
      Effect.flatMap((connection) => connection.retryNow),
      Effect.ignore
    );

  /** Runs `effect` as the Host's one piece of background work, replacing any before it. */
  const launch = (key: string, effect: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const previous = work.get(key);

      if (previous !== undefined) yield* Fiber.interrupt(previous);
      work.set(key, yield* Effect.forkIn(effect, scope));
    });

  const finishCheck = (
    key: string,
    snapshot: import("./installFlow.ts").InstallSnapshot,
    installedVersion: string | null,
    bundledVersion: string | null,
    skipped: boolean
  ) =>
    Effect.gen(function* () {
      const problem = snapshot.context.problem;

      if (problem !== null) {
        yield* finishUpdate(key, {
          at: Date.now(),
          result: "failed",
          from: installedVersion,
          version: bundledVersion,
          problem: { ...problem, sshFailure: null },
        });
      } else if (snapshot.context.outcome !== null && !skipped) {
        yield* finishUpdate(key, {
          at: Date.now(),
          result: snapshot.context.outcome.kind === "newer" ? "newer" : "current",
          from: installedVersion,
          version: installedVersion,
          problem: null,
        });
      } else {
        yield* updateFacts(key, { progress: null });
      }
    });

  /** Records a failed check or install: the flow's problem, and the update's last result. */
  const failInstall = (
    key: string,
    problem: InstallProblem,
    sshFailure: SshError["failure"] | null = null
  ) =>
    step(key, { type: "failed", problem }).pipe(
      Effect.andThen(
        finishUpdate(key, {
          at: Date.now(),
          result: "failed",
          from: updates.get(key)?.installedVersion ?? null,
          version: updates.get(key)?.bundledVersion ?? bundled,
          problem: {
            kind: problem.kind,
            message: problem.message,
            command: problem.command,
            sshFailure,
          },
        })
      )
    );

  /** Any failure of a check or install, as the flow's problem. */
  const recover =
    (key: string) =>
    <A, E extends Failure, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catch((error) => {
          if (error instanceof SshError)
            return failInstall(
              key,
              { kind: "ssh", message: failureMessage(error), command: null },
              error.failure
            );

          if (error instanceof TaskConflict) {
            const conflict = { task: error.task, otherHome: error.otherHome };

            return failInstall(key, {
              kind: "task-conflict",
              message: error.message,
              command: null,
              conflict,
            });
          }

          return failInstall(key, {
            kind: "failed",
            message: failureMessage(error),
            command: null,
          });
        }),
        Effect.asVoid
      );

  /** Installs or upgrades as `work` says, then records the outcome and reconnects. */
  const applyStep = (key: string, to: HostChannel, work: InstallWork, replaceTask: boolean) =>
    Effect.gen(function* () {
      const outcome = yield* applyWork(
        to,
        work,
        {
          progress: progress(key),
          download: input.download,
          clientVersion: input.clientVersion,
          replaceTask,
        },
        { platform: input.platform, processes: input.processes }
      );

      yield* localListening(to.home);

      yield* step(key, { type: "applied", outcome });
      yield* finishUpdate(key, {
        at: Date.now(),
        result: "updated",
        from: outcome.from,
        version: outcome.version,
        problem: null,
      });
      yield* retryConnection(key);
    });

  /** The flow after `check` moved to checking: plan, then maybe install. */
  const checkBody = (key: string, to: HostChannel, trigger: InstallTrigger, updateOnly = false) =>
    Effect.gen(function* () {
      const {
        platform,
        plan: proposed,
        size,
        installedVersion,
        bundledVersion,
        windowsShell,
      } = yield* planFor(to, {
        trigger,
        approved: to.trusted ? new Set<string>() : input.approvals.approved(key),
        builds: input.builds,
        onBuild: setRecord(key, { activity: "Building the daemon for this host from source" }),
        platform: input.platform,
        processes: input.processes,
      });

      yield* rememberWindowsShell(key, windowsShell);
      bundledBuilds = yield* input.builds
        .forPlatform(null, { build: false, onBuild: Effect.void })
        .pipe(Effect.orElseSucceed(() => []));
      bundled = bundledBuilds[0]?.version ?? null;
      const hosts = yield* SubscriptionRef.get(dir.views);
      yield* updateFacts(key, {
        platform,
        installedVersion,
        bundledVersion,
        epoch: hosts.find((h) => h.key === key)?.status.epoch ?? 0,
      });

      const plan =
        trigger === "background" &&
        !updatePolicy(input.settings.get(), key).keepUpToDate &&
        Predicate.isTagged(proposed, "Upgrade")
          ? InstallPlan.UpToDate({ version: proposed.from })
          : proposed;

      if (updateOnly && installsAnew(plan)) {
        const message = to.trusted
          ? `${copy.localHost} has no daemon Polaris installed yet. Use Install first.`
          : "No daemon is installed. Use Install daemon first.";

        return yield* failInstall(key, { kind: "failed", message, command: null });
      }

      yield* setRecord(key, { offerSize: size });

      const activity = deliveryActivity(plan, {
        host: to.alias,
        copying: channelActivity(to, copy).copying,
        platform: input.platform ?? process.platform,
      });

      const planned = yield* step(key, { type: "planned", plan, trusted: to.trusted }, activity);

      const pending = planned.value === "installing" ? planned.context.work : null;

      if (pending === null || isStartWork(pending)) {
        yield* finishCheck(key, planned, installedVersion, bundledVersion, proposed !== plan);

        return;
      }

      yield* applyStep(key, to, pending, false);
    }).pipe(recover(key));

  const runCheck = (key: string, to: HostChannel, trigger: InstallTrigger, updateOnly = false) =>
    Effect.gen(function* () {
      const previous = record(key).snapshot;

      const started = yield* step(
        key,
        { type: "check", trigger },
        channelActivity(to, copy).probing
      );

      if (started !== previous && started.value === "checking") {
        yield* updateFacts(key, { progress: { stage: "checking", bytes: 0, total: 0 } });
        yield* launch(key, checkBody(key, to, trigger, updateOnly));
      }
    });

  /** The user asked for a check (or an update only) of the Host `key`. */
  const userCheck = (key: string, updateOnly = false) =>
    Effect.flatMap(channelFor(key), (to) => runCheck(key, to, "user", updateOnly));

  // Background checks: once per occasion a Host's Connection State calls for one.
  const occasions = new Map<string, string>();
  let buildsOccasion = "";

  const background = (hosts: ReadonlyArray<import("../../shared/api.ts").HostView>) =>
    Effect.gen(function* () {
      const nextOccasion = hosts
        .map((h) => `${h.key}:${h.status.state}:${h.status.epoch}:${h.status.since}`)
        .join("|");

      if (buildsOccasion !== nextOccasion) {
        buildsOccasion = nextOccasion;
        bundledBuilds = yield* input.builds
          .forPlatform(null, { build: false, onBuild: Effect.void })
          .pipe(Effect.orElseSucceed(() => []));
        bundled = bundledBuilds[0]?.version ?? null;
      }

      yield* publish;

      for (const host of hosts) {
        if (host.key === LOCAL_HOST_KEY && !local.supported) continue;
        const policy = updatePolicy(input.settings.get(), host.key);
        const missing = host.status.failure?.reason === "polaris-not-installed";

        if (!policy.keepUpToDate && !missing) continue;

        const occasion =
          host.key === LOCAL_HOST_KEY
            ? localUpgradeKey(host, bundled, yield* localHome)
            : backgroundCheckKey(host, bundled);

        if (occasion === null) continue;
        const key = `${occasion}:${bundled}`;

        if (occasions.get(host.key) === key) continue;
        occasions.set(host.key, key);
        // A Host with no channel (a test socket Host) is never checked.
        yield* channelFor(host.key).pipe(
          Effect.flatMap((to) => runCheck(host.key, to, "background")),
          Effect.ignore
        );
      }
    });

  yield* SubscriptionRef.changes(dir.views).pipe(
    Stream.runForEach(background),
    Effect.forkIn(scope)
  );

  const add = (machine: AddMachine) =>
    Effect.gen(function* () {
      if (machine.alias === LOCAL_HOST_KEY) {
        return yield* fail(`Polaris names ${copy.machine} "local"; rename the alias to add it`);
      }

      if (remoteSetting(machine.alias) !== undefined) {
        return yield* fail(`${machine.alias} is already a host`);
      }

      const base: RemoteHostSetting = { alias: machine.alias, forwardAgent: machine.forwardAgent };

      const setting: RemoteHostSetting = patched(
        machine.kind === "wsl" ? { ...base, kind: "wsl" } : base,
        { label: machine.label.trim() || machine.alias, colour: machine.colour }
      );

      input.settings.update((s) => ({ ...s, hosts: [...(s.hosts ?? []), setting] }));
      // The user's check starts before the connection can ask for a background one.
      yield* userCheck(machine.alias);
      yield* dir.add(remoteEntry(setting));
      yield* publish;

      return machine.alias;
    });

  const replaceRemote = (key: string, next: RemoteHostSetting) =>
    Effect.gen(function* () {
      input.settings.update((s) => ({
        ...s,
        hosts: (s.hosts ?? []).map((h) => (h.alias === key ? next : h)),
      }));
      yield* dir.add(remoteEntry(next));
      yield* publish;
    });

  const update = (key: string, patch: MachinePatch) =>
    Effect.flatMap(requireRemote(key), (remote) => replaceRemote(key, patched(remote, patch)));

  /** Keeps the probe's Windows DefaultShell on the Host, so its connection speaks PowerShell. */
  function rememberWindowsShell(key: string, shell: WindowsShell | null) {
    const remote = remoteSetting(key);

    if (remote === undefined || (remote.windowsShell ?? null) === shell) return Effect.void;

    const { windowsShell: _previous, ...rest } = remote;

    return replaceRemote(key, shell === null ? rest : { ...rest, windowsShell: shell });
  }

  const remove = (key: string) =>
    Effect.gen(function* () {
      yield* requireRemote(key);
      input.settings.update((s) => ({
        ...s,
        hosts: (s.hosts ?? []).filter((h) => h.alias !== key),
        daemonUpdates: Object.fromEntries(
          Object.entries(s.daemonUpdates ?? {}).filter(([alias]) => alias !== key)
        ),
      }));
      input.approvals.forget(key);
      const running = work.get(key);
      work.delete(key);

      if (running !== undefined) yield* Fiber.interrupt(running);
      installs.delete(key);
      updates.delete(key);
      occasions.delete(key);
      buildsOccasion = "";
      yield* dir.remove(key);
      yield* publish;
    });

  const approve = (key: string, sha256: string) =>
    Effect.gen(function* () {
      const offer = record(key).snapshot.context.offer;

      if (offer === null || offer.sha256 !== sha256) {
        return yield* fail("that build is no longer the one offered; check again");
      }

      const to = yield* channelFor(key);
      input.approvals.approve(key, { ...offer, approvedAt: Date.now() });
      const approved = yield* step(key, { type: "approve" }, channelActivity(to, copy).probing);

      if (approved.value === "checking") {
        yield* updateFacts(key, { progress: { stage: "checking", bytes: 0, total: 0 } });
        yield* launch(key, checkBody(key, to, "user"));
      }
    });

  const takeOverTask = (key: string) =>
    Effect.gen(function* () {
      const to = yield* channelFor(key);
      const next = yield* step(key, { type: "takeOver" }, "Taking over the sign-in task");
      const held = next.value === "installing" ? next.context.work : null;

      if (held === null) return yield* fail("Nothing is waiting on the sign-in task; check again.");
      yield* updateFacts(key, { progress: { stage: "checking", bytes: 0, total: 0 } });

      const rerun: Effect.Effect<void, Failure> = isStartWork(held)
        ? startStep(key, to, true)
        : applyStep(key, to, held, true);

      yield* launch(key, rerun.pipe(recover(key)));
    });

  /** Start daemon's run; a sign-in task another home holds goes to the take-over card. */
  const startStep = (key: string, to: HostChannel, replaceTask: boolean) =>
    Effect.gen(function* () {
      const shell = remoteSetting(key)?.windowsShell ?? null;
      const local = { platform: input.platform, processes: input.processes };

      yield* startDaemon(to, local, shell, replaceTask);
      yield* localListening(to.home).pipe(Effect.ensuring(retryConnection(key)));

      if (replaceTask) {
        yield* step(key, { type: "started" });
        yield* updateFacts(key, { progress: null });
      }
    });

  /** Start daemon: `polaris install` with the installed build; on this Mac with none, install it. */
  const restart = (key: string) =>
    Effect.gen(function* () {
      const to = yield* channelFor(key);

      if (
        to.home !== null &&
        !existsSync(installedPaths(to.home, input.platform ?? process.platform).binary)
      ) {
        return yield* runCheck(key, to, "user");
      }

      yield* startStep(key, to, false).pipe(
        Effect.catchTag("TaskConflict", ({ message, task, otherHome }) =>
          step(key, {
            type: "startConflict",
            problem: {
              kind: "task-conflict",
              message,
              command: null,
              conflict: { task, otherHome },
            },
          })
        ),
        Effect.mapError((error) => (error instanceof MachineError ? error : asMachineError(error)))
      );
    });

  const restartTarget = (key: string) =>
    Effect.gen(function* () {
      const channel = yield* channelFor(key);
      const connection = yield* dir.connection(key).pipe(Effect.mapError(asMachineError));
      const name = dir.entry(key)?.label ?? key;
      const windowsShell = (remoteSetting(key)?.windowsShell ?? null) !== null;
      const platform = input.platform ?? process.platform;

      return { name, channel, connection, windowsShell, platform, processes: input.processes };
    });

  const setLocalEnabled = (enabled: boolean) =>
    Effect.gen(function* () {
      if (!local.supported) return yield* fail(copy.localHostUnsupported);
      input.settings.update((s) => ({ ...s, local: { ...s.local, enabled } }));

      if (!enabled) {
        yield* dir.remove(LOCAL_HOST_KEY);
      } else if (dir.entry(LOCAL_HOST_KEY) === undefined) {
        const daemon = yield* local.resolve.pipe(
          Effect.mapError(
            (error) =>
              new MachineError({ message: `the local daemon didn't start: ${error.message}` })
          )
        );

        yield* dir.add(localEntry(daemon, local.label));
      }

      occasions.delete(LOCAL_HOST_KEY);
      yield* Effect.flatMap(SubscriptionRef.get(dir.views), background);
      yield* publish;
    });

  const terminal = (argv: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: () => input.openTerminal(argv),
      catch: (cause) => new MachineError({ message: `Terminal didn't open: ${String(cause)}` }),
    });

  yield* publish;

  const setDaemonUpdateOverride = (key: string, enabled: boolean | null) =>
    Effect.gen(function* () {
      if (key === LOCAL_HOST_KEY && !local.supported) return yield* fail(copy.localHostUnsupported);

      if (key !== LOCAL_HOST_KEY) yield* requireRemote(key);
      input.settings.update((s) => {
        const override = <T extends { readonly keepDaemonUpToDate?: boolean }>(host: T) => {
          const { keepDaemonUpToDate: _previous, ...rest } = host;

          return enabled === null ? rest : { ...rest, keepDaemonUpToDate: enabled };
        };

        return key === LOCAL_HOST_KEY
          ? { ...s, local: override(s.local ?? { enabled: true }) }
          : { ...s, hosts: (s.hosts ?? []).map((h) => (h.alias === key ? override(h) : h)) };
      });
      occasions.delete(key);
      buildsOccasion = "";
      yield* Effect.flatMap(SubscriptionRef.get(dir.views), background);
      yield* publish;
    });

  return Machines.of({
    views,
    sshAliases: Effect.sync(() => {
      aliases = input.aliases();

      return aliases;
    }).pipe(Effect.tap(() => publish)),
    add,
    update,
    remove,
    check: (key) => userCheck(key),
    updateDaemon: (key) => userCheck(key, true),
    setKeepDaemonsUpToDate: (enabled) =>
      Effect.sync(() =>
        input.settings.update((s) => ({ ...s, keepDaemonsUpToDate: enabled }))
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            occasions.clear();
            buildsOccasion = "";
          })
        ),
        Effect.andThen(Effect.flatMap(SubscriptionRef.get(dir.views), background)),
        Effect.andThen(publish)
      ),
    setDaemonUpdateOverride,
    approve,
    dismiss: (key) => Effect.asVoid(step(key, { type: "dismiss" })),
    takeOverTask,
    startDaemon: restart,
    restartDaemon: (key) => Effect.flatMap(restartTarget(key), restartOver),
    restartPreview: (key) => Effect.flatMap(restartTarget(key), previewOver),
    setLocalEnabled,
    wslDistros:
      input.discoverWsl === undefined
        ? Effect.succeed(wslDistrosView(WslDiscovery.Unsupported()))
        : Effect.map(input.discoverWsl, wslDistrosView),
    openSsh: (key) =>
      channelFor(key).pipe(
        Effect.flatMap((to) => to.interactiveArgv),
        Effect.catchTag("HostActionUnsupported", (error) => fail(unsupportedMessage(error, copy))),
        Effect.flatMap(terminal)
      ),
  });
});
