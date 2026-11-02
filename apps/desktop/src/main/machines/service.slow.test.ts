/**
 * `Machines` end to end against a fake Host: commands "sent over ssh" run in
 * a local `sh` with HOME at a temporary directory, so the real probe, upload
 * and SHA-256 scripts run. The Host list is a stand-in the test drives, to
 * play reconnects.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAccess } from "@polaris/client/access";
import { Ssh, SshError } from "@polaris/client/install";
import {
  type ChildProcessApi,
  type SpawnRequest,
  scriptedChildProcess,
} from "@polaris/client/process";
import { HostId, HostInfo } from "@polaris/protocol";
import { Effect, Layer, ManagedRuntime, Option, Schema, Stream, SubscriptionRef } from "effect";
import type { ConnectionStatusView, HostView, MachineView } from "../../shared/api.ts";
import { HostDirectory, type HostEntry, UnknownHost } from "../hosts.ts";
import { LocalHost, testDaemon } from "../local/index.ts";
import type { Settings } from "../settings.ts";
import { openApprovals } from "./approvals.ts";
import { locateBuilds } from "./builds.ts";
import { hostPlatform, runOnFakeHost, writeDist } from "./fakeHost.testing.ts";
import { Machines } from "./service.ts";

const platform = hostPlatform();

let root: string;

let home: string;

let dist: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-machines-"));
  home = join(root, "host");
  // Like any real Host's: the install creates ~/.polaris in it, never HOME itself.
  mkdirSync(home);
  dist = join(root, "dist");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const status = (patch: Partial<ConnectionStatusView>): ConnectionStatusView => ({
  state: "reconnecting",
  failure: null,
  attempt: 0,
  since: 1,
  nextAttemptAt: null,
  host: null,
  capabilities: [],
  epoch: 0,
  latencyMs: null,
  lastSeenAt: null,
  ...patch,
});

const setup = (
  sshFails = false,
  localHome: string | null = null,
  initial: Settings = {},
  probeOutput?: () => string,
  clientPlatform?: NodeJS.Platform,
  localListening: (home: string) => Promise<void> = () => Promise.resolve(),
  /** A Windows x64 Client's `polaris.exe`, scripted; without it Windows is Windows on Arm. */
  processes?: ChildProcessApi
) => {
  let settings: Settings = initial;
  const commands: Array<string> = [];
  const hostViews = Effect.runSync(SubscriptionRef.make<ReadonlyArray<HostView>>([]));
  const entries = new Map<string, HostEntry>();
  const retried: Array<string> = [];

  const directory = Layer.succeed(
    HostDirectory,
    HostDirectory.of({
      views: hostViews,
      entry: (key) => entries.get(key),
      connection: (key) =>
        key === "studio" || key === "local"
          ? // SAFETY: the service only calls `retryNow` on the connection here.
            Effect.succeed({ retryNow: Effect.sync(() => void retried.push(key)) } as never)
          : Effect.fail(new UnknownHost(key)),
      add: (entry) => Effect.sync(() => void entries.set(entry.key, entry)),
      remove: (key) => Effect.sync(() => void entries.delete(key)),
    })
  );

  const machines = Machines.layer({
    platform: clientPlatform,
    settings: { get: () => settings, update: (change) => void (settings = change(settings)) },
    approvals: openApprovals(join(root, "approvals.json")),
    builds: locateBuilds({
      env: { POLARIS_DESKTOP_DAEMON_DIST: dist },
      resources: null,
      repoRoot: root,
      buildOnDemand: false,
    }),
    aliases: () => [{ alias: "studio", hostName: "studio.lan", user: null }],
    openTerminal: () => Promise.resolve(),
    processes,
  });

  // This Mac's Daemon: installed in `localHome`, or with none the app's own dev Daemon; none on Windows on Arm.
  const localHost =
    clientPlatform === "win32" && processes === undefined
      ? LocalHost.unsupported()
      : LocalHost.test({ daemon: testDaemon(localHome), listening: localListening });

  const remote = Layer.succeed(
    Ssh,
    Ssh.of({
      exec: (alias, command, options) =>
        sshFails
          ? Effect.fail(
              new SshError({
                alias,
                failure: "host-key",
                message: "Host key verification failed.",
              })
            )
          : Effect.sync(() => void commands.push(command)).pipe(
              Effect.andThen(
                probeOutput !== undefined && command.includes("uname -s")
                  ? Effect.succeed({
                      code: 0,
                      stdout: probeOutput(),
                      stderr: "",
                    })
                  : Ssh.use((ssh) => ssh.exec(alias, command, options)).pipe(
                      Effect.provide(Ssh.local(home))
                    )
              )
            ),
    })
  );

  // Remote commands go to the fake Host above; this Mac's run in a local shell.
  const access = HostAccess.fromRunners(
    {
      ssh: remote,
      wsl: Layer.succeed(Ssh, Ssh.of({ exec: () => Effect.die("no WSL Host in this test") })),
      local: (localHome) => Ssh.local(localHome),
    },
    { platform: clientPlatform }
  );

  const runtime = ManagedRuntime.make(
    Layer.provideMerge(Layer.provide(machines, Layer.mergeAll(access, localHost)), directory)
  );

  /** Waits until the studio row satisfies `predicate`. */
  const studio = (predicate: (view: MachineView) => boolean) =>
    runtime.runPromise(
      Machines.use((m) =>
        SubscriptionRef.changes(m.views).pipe(
          Stream.map((views) => views.find((v) => v.key === "studio")),
          Stream.filter((view): view is MachineView => view !== undefined && predicate(view)),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
          Effect.timeout(5000)
        )
      )
    );

  const setStatus = (patch: Partial<ConnectionStatusView>) =>
    runtime.runPromise(
      SubscriptionRef.set(hostViews, [
        {
          key: "studio",
          label: "Mac Studio",
          colour: null,
          alias: "studio",
          kind: "ssh",
          proofHarness: false,
          status: status(patch),
        },
      ])
    );

  /** Waits until this Mac's row satisfies `predicate`. */
  const local = (predicate: (view: MachineView) => boolean) =>
    runtime.runPromise(
      Machines.use((m) =>
        SubscriptionRef.changes(m.views).pipe(
          Stream.map((views) => views.find((v) => v.key === "local")),
          Stream.filter((view): view is MachineView => view !== undefined && predicate(view)),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
          Effect.timeout(5000)
        )
      )
    );

  const setLocal = (patch: Partial<ConnectionStatusView>) =>
    runtime.runPromise(
      SubscriptionRef.set(hostViews, [
        {
          key: "local",
          label: "This Mac",
          colour: null,
          alias: null,
          kind: "local",
          proofHarness: false,
          status: status(patch),
        },
      ])
    );

  const call = <A, E>(use: (m: Machines["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Machines.use(use));

  return {
    runtime,
    studio,
    setStatus,
    local,
    setLocal,
    call,
    retried,
    commands,
    settings: () => settings,
    entries,
  };
};

const installed = () => existsSync(join(home, ".polaris", "bin", "current", "polaris"));

const info = (daemonVersion: string, reportedPlatform = platform) =>
  new HostInfo({
    hostId: HostId.make("studio"),
    hostname: "studio",
    platform: Schema.decodeUnknownSync(HostInfo.fields.platform)(reportedPlatform),
    daemonVersion,
    homeDir: home,
    startedAt: "2026-09-30T00:00:00Z",
  });

describe("Machines", () => {
  test("Windows on Arm rejects local enable, checks and upgrades before touching a local Daemon", async () => {
    const s = setup(false, home, { local: { enabled: true } }, undefined, "win32");

    try {
      for (const use of [
        (m: Machines["Service"]) => m.setLocalEnabled(true),
        (m: Machines["Service"]) => m.check("local"),
        (m: Machines["Service"]) => m.updateDaemon("local"),
        (m: Machines["Service"]) => m.setDaemonUpdateOverride("local", true),
      ]) {
        const error = await s.runtime.runPromise(Machines.use(use).pipe(Effect.flip));
        expect(error.message).toBe("Polaris has no daemon for Windows on Arm yet.");
      }

      const views = await s.runtime.runPromise(Machines.use((m) => SubscriptionRef.get(m.views)));
      expect(views.some((view) => view.key === "local")).toBe(false);
      expect(s.commands).toEqual([]);
    } finally {
      await s.runtime.dispose();
    }
  });
  test.each([
    {
      probe: "os=Windows\narch=x86_64\n",
      buildPlatform: "darwin-arm64",
      kind: "unsupported",
      command: null,
    },
    {
      probe: "os=Linux\narch=aarch64\n",
      buildPlatform: "darwin-arm64",
      kind: "missing-build",
      command: null,
    },
    {
      probe: "os=Linux\narch=aarch64\nlibc=musl\nmissing=libstdc++.so.6\n",
      buildPlatform: "linux-arm64-musl",
      kind: "host-setup",
      command: "apk add libstdc++ libgcc",
    },
  ])(
    "Update reports $kind with an actionable result",
    async ({ probe, buildPlatform, kind, command }) => {
      writeDist(dist, { version: "0.2.0", platform: buildPlatform });

      const { runtime, call, studio, commands } = setup(
        false,
        null,
        { hosts: [{ alias: "studio" }] },
        () => probe
      );

      try {
        await call((m) => m.updateDaemon("studio"));
        const row = await studio((v) => v.daemon?.progress?.stage === "failed");
        expect(row?.daemon?.lastUpdate).toMatchObject({
          result: "failed",
          problem: { kind, command, sshFailure: null },
        });
        expect(commands).toHaveLength(1);
      } finally {
        await runtime.dispose();
      }
    }
  );
  test("Update refuses a first install even with an approved hash", async () => {
    const sha = writeDist(dist, { version: "0.2.0", platform });
    openApprovals(join(root, "approvals.json")).approve("studio", {
      sha256: sha,
      platform,
      version: "0.2.0",
      approvedAt: 1,
    });
    const { runtime, call, studio } = setup(false, null, { hosts: [{ alias: "studio" }] });

    try {
      await call((m) => m.updateDaemon("studio"));
      const row = await studio((v) => v.daemon?.progress?.stage === "failed");
      expect(row?.daemon?.lastUpdate?.problem?.message).toContain("Use Install daemon first");
      expect(row?.daemon?.lastUpdate?.result).toBe("failed");
      expect(installed()).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test.each([
    { buildPlatform: "darwin-arm64", probe: "os=Darwin\narch=arm64\n" },
    { buildPlatform: "linux-x64", probe: "os=Linux\narch=x86_64\nlibc=glibc\n" },
  ])(
    "automatic policy, overrides and explicit Update share facts and stay single flight ($buildPlatform)",
    async ({ buildPlatform, probe }) => {
      writeDist(dist, { version: "0.1.0", platform: buildPlatform });
      runOnFakeHost(home, `mkdir -p "$HOME" && "${join(dist, buildPlatform, "polaris")}" install`);
      writeDist(dist, { version: "0.2.0", platform: buildPlatform });

      const { runtime, call, studio, setStatus, commands, settings } = setup(
        false,
        null,
        {
          keepDaemonsUpToDate: false,
          hosts: [{ alias: "studio" }],
        },
        () => {
          const installedVersion = runOnFakeHost(
            home,
            '"$HOME/.polaris/bin/current/polaris" version'
          ).stdout.trim();

          return `${probe}installed=${installedVersion}\n`;
        }
      );

      try {
        await setStatus({ state: "connected", epoch: 1, host: info("0.1.0", buildPlatform) });
        const available = await studio((v) => v.daemon?.installedVersion === "0.1.0");
        expect(available?.daemon).toMatchObject({
          bundledVersion: "0.2.0",
          updateAvailable: true,
          keepUpToDate: false,
          keepUpToDateOverride: null,
        });
        expect(commands).toHaveLength(0);
        await Promise.all([
          call((m) => m.updateDaemon("studio")),
          call((m) => m.updateDaemon("studio")),
          call((m) => m.check("studio")),
        ]);
        const done = await studio((v) => v.daemon?.progress?.stage === "done");
        expect(done?.daemon?.lastUpdate).toMatchObject({
          result: "updated",
          from: "0.1.0",
          version: "0.2.0",
          problem: null,
        });
        expect(done?.daemon?.lastUpdate?.at).toBeGreaterThan(0);
        expect(done?.daemon?.installedVersion).toBe("0.2.0");
        expect(done?.daemon?.updateAvailable).toBe(false);
        expect(commands.filter((s) => s.includes(" upgrade "))).toHaveLength(1);
        await call((m) => m.updateDaemon("studio"));
        await studio((v) => v.daemon?.lastUpdate?.result === "current");
        expect(commands.filter((s) => s.includes(" upgrade "))).toHaveLength(1);
        expect(settings().daemonUpdates?.studio?.result).toBe("current");
        runOnFakeHost(home, 'ln -sfn 0.1.0 "$HOME/.polaris/bin/current"');
        await call((m) => m.setDaemonUpdateOverride("studio", true));
        await studio((v) => v.daemon?.lastUpdate?.result === "updated");
        expect(settings().hosts?.[0]?.keepDaemonUpToDate).toBe(true);
        expect(commands.filter((s) => s.includes(" upgrade "))).toHaveLength(2);
        await call((m) => m.setDaemonUpdateOverride("studio", null));
        const inherited = await studio((v) => v.daemon?.keepUpToDateOverride === null);
        expect(inherited?.daemon?.keepUpToDate).toBe(false);
      } finally {
        await runtime.dispose();
      }
    }
  );

  test("enabling the app default checks already connected Hosts; off overrides win", async () => {
    writeDist(dist, { version: "0.1.0", platform });
    runOnFakeHost(home, `mkdir -p "$HOME" && "${join(dist, platform, "polaris")}" install`);
    writeDist(dist, { version: "0.0.0-dev.500.abc1234", platform });

    const { runtime, call, studio, setStatus, commands } = setup(false, null, {
      keepDaemonsUpToDate: false,
      hosts: [{ alias: "studio", keepDaemonUpToDate: false }],
    });

    try {
      await setStatus({ state: "connected", epoch: 4, host: info("0.1.0") });
      await studio((v) => v.daemon?.installedVersion === "0.1.0");
      await call((m) => m.setKeepDaemonsUpToDate(true));
      const held = await studio((v) => v.daemon?.keepDaemonsUpToDate === true);
      expect(held?.daemon?.keepUpToDate).toBe(false);
      expect(commands).toHaveLength(0);
      await call((m) => m.setDaemonUpdateOverride("studio", null));
      const updated = await studio((v) => v.daemon?.lastUpdate?.result === "updated");
      expect(updated?.daemon?.lastUpdate?.version).toBe("0.0.0-dev.500.abc1234");
    } finally {
      await runtime.dispose();
    }
  });

  test("SSH failure includes its actionable kind and result time", async () => {
    writeDist(dist, { version: "0.2.0", platform });
    const { runtime, call, studio } = setup(true, null, { hosts: [{ alias: "studio" }] });

    try {
      await call((m) => m.updateDaemon("studio"));
      const failed = await studio((v) => v.daemon?.progress?.stage === "failed");
      expect(failed?.daemon?.lastUpdate).toMatchObject({
        result: "failed",
        problem: { kind: "ssh", sshFailure: "host-key" },
      });
    } finally {
      await runtime.dispose();
    }
  });
  test("add, approve and install; the approval persists and the Host reconnects", async () => {
    const sha = writeDist(dist, { version: "0.2.0", platform });
    const { runtime, studio, call, retried, settings, entries } = setup();

    await call((m) =>
      m.add({ alias: "studio", label: "Mac Studio", colour: null, forwardAgent: false })
    );
    expect(settings().hosts).toEqual([
      { alias: "studio", forwardAgent: false, label: "Mac Studio" },
    ]);
    expect(entries.get("studio")?.remoteCommand).toBeNull();

    const asked = await studio((v) => v.install?.step === "approval");
    expect(asked?.install?.offer).toMatchObject({ platform, version: "0.2.0", sha256: sha });
    expect(installed()).toBe(false);

    await call((m) => m.approve("studio", sha));
    const done = await studio((v) => v.install?.step === "ready");
    expect(done?.install?.outcome?.kind).toBe("installed");
    expect(installed()).toBe(true);
    expect(retried).toContain("studio");
    expect([...openApprovals(join(root, "approvals.json")).approved("studio")]).toEqual([sha]);
    await runtime.dispose();
  });

  test("a reconnect that finds no Daemon asks again and never installs, even approved", async () => {
    const sha = writeDist(dist, { version: "0.2.0", platform });
    openApprovals(join(root, "approvals.json")).approve("studio", {
      sha256: sha,
      platform,
      version: "0.2.0",
      approvedAt: 1,
    });
    const { runtime, studio, setStatus, call } = setup();
    await call((m) => m.add({ alias: "studio", label: "", colour: null, forwardAgent: false }));
    // The user's own check installs the approved build.
    await studio((v) => v.install?.outcome?.kind === "installed");
    rmSync(join(home, ".polaris"), { recursive: true, force: true });

    await setStatus({
      state: "needs-attention",
      since: 50,
      failure: { kind: "needs-attention", reason: "polaris-not-installed", detail: "" },
    });
    const asked = await studio((v) => v.install?.step === "approval");
    expect(asked?.install?.offer?.sha256).toBe(sha);
    expect(installed()).toBe(false);
    await runtime.dispose();
  });

  test("a connection to an older Daemon upgrades in the background and says so", async () => {
    writeDist(dist, { version: "0.1.0", platform });
    runOnFakeHost(home, `mkdir -p "$HOME" && "${join(dist, platform, "polaris")}" install`);
    writeDist(dist, { version: "0.2.0", platform });
    const { runtime, studio, setStatus, call } = setup();
    await call((m) => m.add({ alias: "studio", label: "", colour: null, forwardAgent: false }));
    await studio((v) => v.install?.step === "ready");

    // An upgrade happens whatever the trigger; make sure this one is the reconnect's.
    runOnFakeHost(home, `ln -sfn 0.1.0 "$HOME/.polaris/bin/current"`);
    await setStatus({ state: "connected", epoch: 7, host: info("0.1.0") });
    const upgraded = await studio((v) => v.install?.outcome?.kind === "upgraded");
    expect(upgraded?.install?.outcome).toMatchObject({ from: "0.1.0", version: "0.2.0" });
    await runtime.dispose();
  });

  test("not now parks the Host; settings changes are kept", async () => {
    writeDist(dist, { version: "0.2.0", platform });
    const { runtime, studio, call, settings } = setup();
    await call((m) => m.add({ alias: "studio", label: "", colour: null, forwardAgent: true }));
    await studio((v) => v.install?.step === "approval");
    await call((m) => m.dismiss("studio"));
    await studio((v) => v.install?.step === "dismissed");

    await call((m) => m.update("studio", { remoteCommand: "  polaris bridge ", label: "Studio" }));
    expect(settings().hosts?.[0]).toMatchObject({
      label: "Studio",
      remoteCommand: "polaris bridge",
    });
    await call((m) => m.update("studio", { remoteCommand: null }));
    expect(settings().hosts?.[0]?.remoteCommand).toBeUndefined();
    expect(settings().hosts?.[0]?.forwardAgent).toBe(true);
    await runtime.dispose();
  });

  test("ssh failing during the check is an ssh problem, not a failed install", async () => {
    writeDist(dist, { version: "0.2.0", platform });
    const { runtime, studio, call } = setup(true);
    await call((m) => m.add({ alias: "studio", label: "", colour: null, forwardAgent: false }));
    const blocked = await studio((v) => v.install?.step === "blocked");
    expect(blocked?.install?.problem).toEqual({
      kind: "ssh",
      message: "Host key verification failed.",
      command: null,
    });
    await runtime.dispose();
  });

  test("an ssh alias named local is refused before it can shadow the local Host", async () => {
    const { runtime, settings } = setup(false, null, {}, undefined, "darwin");

    const error = await runtime.runPromise(
      Machines.use((m) =>
        m.add({ alias: "local", label: "", colour: null, forwardAgent: false })
      ).pipe(Effect.flip)
    );

    expect(error.message).toBe('Polaris names this Mac "local"; rename the alias to add it');
    expect(settings().hosts).toBeUndefined();
    await runtime.dispose();
  });

  test("remove forgets the Host and its approvals", async () => {
    const sha = writeDist(dist, { version: "0.2.0", platform });
    openApprovals(join(root, "approvals.json")).approve("studio", {
      sha256: sha,
      platform,
      version: "0.2.0",
      approvedAt: 1,
    });
    const { runtime, studio, call, settings } = setup();
    await call((m) => m.add({ alias: "studio", label: "", colour: null, forwardAgent: false }));
    await studio((v) => v.install?.step === "ready");
    await call((m) => m.remove("studio"));
    expect(settings().hosts).toEqual([]);
    expect(openApprovals(join(root, "approvals.json")).approved("studio").size).toBe(0);
    await runtime.dispose();
  });
});

describe("this PC's own Daemon on Windows", () => {
  const OTHER_HOME = "C:\\Users\\lucas\\dev\\.polaris";

  /** `polaris.exe install`: refused while another home holds the task, unless `--replace-task`. */
  const heldTask = () => {
    const spawned: Array<SpawnRequest> = [];

    const processes = scriptedChildProcess((request) => {
      spawned.push(request);

      const report = request.args.includes("--replace-task")
        ? { ok: true, action: "installed", notes: [] }
        : {
            ok: false,
            error: "TaskConflictError",
            message: "the scheduled task dev.lux.polaris.lucas runs another home",
            task: "dev.lux.polaris.lucas",
            otherHome: OTHER_HOME,
          };

      return { exit: { code: report.ok ? 0 : 3, stdout: `${JSON.stringify(report)}\r\n` } };
    });

    return { spawned, processes };
  };

  test("a sign-in task another home holds stops the install and says whose it is; nothing reruns on its own", async () => {
    writeDist(dist, { version: "0.2.0", platform: "windows-x64" });
    const { spawned, processes } = heldTask();
    const s = setup(false, home, {}, undefined, "win32", undefined, processes);

    try {
      await s.call((m) => m.check("local"));

      const row = await s.local(
        (v) => v.install?.step === "blocked" && v.daemon?.lastUpdate?.result === "failed"
      );

      expect(row?.install?.problem).toMatchObject({
        kind: "task-conflict",
        conflict: { task: "dev.lux.polaris.lucas", otherHome: OTHER_HOME },
      });
      expect(row?.daemon?.lastUpdate?.problem?.kind).toBe("task-conflict");
      expect(spawned.map((r) => r.args.includes("--replace-task"))).toEqual([false]);
    } finally {
      await s.runtime.dispose();
    }
  });

  test("taking over reruns the same install with --replace-task, once", async () => {
    writeDist(dist, { version: "0.2.0", platform: "windows-x64" });
    const { spawned, processes } = heldTask();
    const s = setup(false, home, {}, undefined, "win32", undefined, processes);

    try {
      await s.call((m) => m.check("local"));
      await s.local((v) => v.install?.step === "blocked");
      await s.call((m) => m.takeOverTask("local"));
      const done = await s.local((v) => v.install?.outcome?.kind === "installed");

      expect(done?.install?.outcome?.version).toBe("0.2.0");
      expect(spawned.map((r) => r.args.slice(0, 2))).toEqual([
        ["install", "--json"],
        ["install", "--json"],
      ]);
      expect(spawned.map((r) => r.args.includes("--replace-task"))).toEqual([false, true]);
      // Nothing is held any more: a second take-over has nothing to rerun.

      const again = await s.runtime.runPromise(
        Machines.use((m) => m.takeOverTask("local")).pipe(Effect.flip)
      );

      expect(again.message).toBe("Nothing is waiting on the sign-in task; check again.");
    } finally {
      await s.runtime.dispose();
    }
  });
});

describe("this Mac's own Daemon", () => {
  test("the local override can opt out, and explicit Update still updates its temp home", async () => {
    writeDist(dist, { version: "0.1.0", platform });
    runOnFakeHost(home, `mkdir -p "$HOME" && "${join(dist, platform, "polaris")}" install`);
    writeDist(dist, { version: "0.2.0", platform });

    const { runtime, call, setLocal, local, settings } = setup(false, home, {
      local: { enabled: true, keepDaemonUpToDate: false },
    });

    try {
      await setLocal({ state: "connected", epoch: 1, host: info("0.1.0") });
      const available = await local((v) => v.daemon?.installedVersion === "0.1.0");
      expect(available?.daemon?.keepUpToDate).toBe(false);
      await call((m) => m.updateDaemon("local"));
      const updated = await local((v) => v.daemon?.lastUpdate?.result === "updated");
      expect(updated?.daemon?.installedVersion).toBe("0.2.0");
      await call((m) => m.setLocalEnabled(false));
      expect(settings().local).toEqual({ enabled: false, keepDaemonUpToDate: false });
    } finally {
      await runtime.dispose();
    }
  });

  const installedVersion = () =>
    runOnFakeHost(home, '"$HOME/.polaris/bin/current/polaris" version').stdout.trim();

  test("an older installed Daemon upgrades on connection, with no approval, and says so", async () => {
    writeDist(dist, { version: "0.1.0", platform });
    runOnFakeHost(home, `mkdir -p "$HOME" && "${join(dist, platform, "polaris")}" install`);
    writeDist(dist, { version: "0.0.0-dev.412.abc1234", platform });
    const { runtime, local, setLocal, retried } = setup(false, home);

    await setLocal({ state: "connected", epoch: 3, host: info("0.1.0") });
    const upgraded = await local((v) => v.install?.outcome?.kind === "upgraded");

    // A dev build replaces any other version, newer-looking or not (`upgradeDue`).
    expect(upgraded?.install?.outcome).toMatchObject({
      from: "0.1.0",
      version: "0.0.0-dev.412.abc1234",
    });
    expect(installedVersion()).toContain("0.0.0-dev.412.abc1234");
    expect(retried).toContain("local");
    await runtime.dispose();
  });

  test("the app's own dev Daemon is never touched", async () => {
    writeDist(dist, { version: "0.2.0", platform });
    const { runtime, local, setLocal, call } = setup(false, null);

    await setLocal({ state: "connected", epoch: 1, host: info("0.1.0") });
    const row = await local(() => true);

    expect(row?.install).toBeNull();
    const refused = await call((m) => Effect.flip(m.check("local")));

    expect(refused.message).toContain("not one Polaris installed");
    await runtime.dispose();
  });

  test("a check with nothing installed here installs the bundled build, with no approval", async () => {
    writeDist(dist, { version: "0.2.0", platform });
    const listened: Array<string> = [];

    const { runtime, local, call, commands, retried } = setup(
      false,
      home,
      {},
      undefined,
      undefined,
      async (h) => void listened.push(h)
    );

    await call((m) => m.check("local"));
    const done = await local((v) => v.install?.outcome?.kind === "installed");

    expect(done?.install?.outcome?.version).toBe("0.2.0");
    expect(installedVersion()).toContain("0.2.0");
    expect(listened).toEqual([home]);
    expect(retried).toContain("local");
    // Never over ssh: this Mac's commands run in a local shell.
    expect(commands).toEqual([]);
    await runtime.dispose();
  });

  test("first launch: a local row with nothing installed installs in the background", async () => {
    writeDist(dist, { version: "0.2.0", platform });
    const { runtime, local, setLocal } = setup(false, home);

    await setLocal({
      state: "needs-attention",
      since: 5,
      failure: { kind: "needs-attention", reason: "polaris-not-installed", detail: "none" },
    });
    await local((v) => v.install?.outcome?.kind === "installed");
    expect(installed()).toBe(true);
    await runtime.dispose();
  });

  test("Start daemon on this Mac installs when nothing is, through the local path", async () => {
    writeDist(dist, { version: "0.2.0", platform });
    const { runtime, local, call, commands } = setup(false, home);

    await call((m) => m.startDaemon("local"));
    await local((v) => v.install?.outcome?.kind === "installed");
    expect(installed()).toBe(true);
    expect(commands).toEqual([]);
    await runtime.dispose();
  });

  test("Start daemon on this Mac runs the installed polaris locally and waits for it", async () => {
    writeDist(dist, { version: "0.2.0", platform });
    runOnFakeHost(home, `mkdir -p "$HOME" && "${join(dist, platform, "polaris")}" install`);
    const listened: Array<string> = [];

    const { runtime, call, commands, retried } = setup(
      false,
      home,
      {},
      undefined,
      undefined,
      async (h) => void listened.push(h)
    );

    await call((m) => m.startDaemon("local"));
    expect(listened).toEqual([home]);
    expect(retried).toEqual(["local"]);
    expect(commands).toEqual([]);
    await runtime.dispose();
  });

  test("Start daemon on this Mac says why the daemon didn't listen", async () => {
    writeDist(dist, { version: "0.2.0", platform });
    runOnFakeHost(home, `mkdir -p "$HOME" && "${join(dist, platform, "polaris")}" install`);

    const { runtime, call, retried } = setup(false, home, {}, undefined, undefined, () =>
      Promise.reject(new Error("the daemon didn't start listening within 15 s · killed: 9"))
    );

    const error = await call((m) => Effect.flip(m.startDaemon("local")));

    expect(error.message).toContain("killed: 9");
    expect(retried).toEqual(["local"]);
    await runtime.dispose();
  });

  test("Start daemon on the app's own dev Daemon is refused, never sent to a remote path", async () => {
    const { runtime, call } = setup(false, null);
    const error = await call((m) => Effect.flip(m.startDaemon("local")));

    expect(error.message).toContain("not one Polaris installed");
    expect(error.message).not.toContain("no remote host");
    await runtime.dispose();
  });
});
