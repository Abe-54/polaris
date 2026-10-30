/** Hosts for the Settings → Hosts preview: every daemon update state, no real host involved. */
import { Capability, HostId, type Platform } from "@polaris/protocol";
import type {
  ConnectionStatusView,
  MachineView,
  SshAliasView,
  WslDistrosView,
} from "../../../../shared/api.ts";
import type { DaemonUpdateView } from "../../../../shared/daemonUpdates.ts";

const MINUTE = 60_000;

const connected = (
  platform: typeof Platform.Type,
  version: string,
  latencyMs: number | null
): ConnectionStatusView => ({
  state: "connected",
  failure: null,
  attempt: 0,
  since: 0,
  nextAttemptAt: null,
  host: {
    hostId: HostId.make(`h-${platform}-${version}`),
    hostname: "host",
    platform,
    daemonVersion: version,
    homeDir: "/home/lucas",
    startedAt: "2026-09-29T00:00:00.000Z",
  },
  capabilities: Capability.literals,
  epoch: 1,
  latencyMs,
  lastSeenAt: null,
});

/** A WSL Host whose wsl.exe or distro went missing (Paper W2). */
const attention = (reason: string, detail: string): ConnectionStatusView => ({
  state: "needs-attention",
  failure: { kind: "needs-attention", reason, detail },
  attempt: 1,
  since: 0,
  nextAttemptAt: null,
  host: null,
  capabilities: [],
  epoch: 0,
  latencyMs: null,
  lastSeenAt: null,
});

const offline = (now: number): ConnectionStatusView => ({
  state: "offline",
  failure: null,
  attempt: 3,
  since: now - 40 * MINUTE,
  nextAttemptAt: null,
  host: null,
  capabilities: [],
  epoch: 0,
  latencyMs: null,
  lastSeenAt: now - 3 * 24 * 60 * MINUTE,
});

export const daemon = (patch: Partial<DaemonUpdateView> = {}): DaemonUpdateView => ({
  managed: true,
  installedVersion: "0.4.1",
  bundledVersion: "0.5.0",
  updateAvailable: true,
  keepDaemonsUpToDate: true,
  keepUpToDateOverride: null,
  keepUpToDate: true,
  progress: null,
  lastUpdate: null,
  ...patch,
});

const machine = (
  key: string,
  label: string,
  alias: string | null,
  status: ConnectionStatusView,
  update: DaemonUpdateView,
  kind: MachineView["kind"] = alias === null ? "local" : "ssh"
): MachineView => ({
  key,
  label,
  colour: null,
  alias,
  kind,
  target: alias === null ? null : { hostName: `${alias}.local`, user: "lucas" },
  enabled: true,
  forwardAgent: false,
  remoteCommand: null,
  status,
  install: null,
  daemon: update,
});

export type Scene = "all" | "current" | "failures" | "live" | "wsl" | "task" | "states";

export const SCENES: ReadonlyArray<Scene> = [
  "all",
  "current",
  "failures",
  "live",
  "wsl",
  "task",
  "states",
];

const thisMac = (update: DaemonUpdateView) =>
  machine(
    "local",
    "MacBook Pro",
    null,
    connected("darwin-arm64", update.installedVersion ?? "0.5.0", null),
    update
  );

/** Every state at once: offer, checking, real bytes, switching, done, waiting for a host. */
const all = (now: number): ReadonlyArray<MachineView> => [
  machine(
    "pi",
    "Raspberry Pi",
    "lucas-rpi",
    connected("linux-arm64", "0.4.1", 38),
    daemon({
      progress: { stage: "uploading", bytes: 7_340_000, total: 18_600_000 },
    })
  ),
  thisMac(
    daemon({
      installedVersion: "0.5.0",
      updateAvailable: false,
      lastUpdate: {
        at: now - 3 * MINUTE,
        result: "updated",
        from: "0.4.1",
        version: "0.5.0",
        problem: null,
      },
    })
  ),
  machine(
    "studio",
    "Mac Studio",
    "studio",
    connected("darwin-arm64", "0.4.1", 4),
    daemon({ keepUpToDateOverride: false, keepUpToDate: false })
  ),
  machine(
    "vm",
    "Build VM",
    "build-vm",
    connected("linux-x64", "0.4.1", 61),
    daemon({
      progress: { stage: "switching", bytes: 0, total: 0 },
    })
  ),
  machine(
    "nuc",
    "NUC",
    "nuc",
    connected("linux-x64", "0.4.1", 12),
    daemon({
      keepUpToDateOverride: false,
      keepUpToDate: false,
      progress: { stage: "checking", bytes: 0, total: 0 },
    })
  ),
  machine(
    "laptop",
    "Old laptop",
    "old-laptop",
    offline(now),
    daemon({ installedVersion: "0.3.9" })
  ),
  machine(
    "Ubuntu",
    "Ubuntu",
    "Ubuntu",
    connected("linux-x64", "0.4.1", 2),
    daemon({ keepUpToDateOverride: false, keepUpToDate: false }),
    "wsl"
  ),
];

const failed = (
  problem: NonNullable<NonNullable<DaemonUpdateView["lastUpdate"]>["problem"]>,
  now: number
) =>
  daemon({
    lastUpdate: { at: now - 2 * MINUTE, result: "failed", from: "0.4.1", version: null, problem },
  });

/** Why an update stopped: missing libraries, ssh host key and auth, a broken copy, no build. */
const failures = (now: number): ReadonlyArray<MachineView> => [
  thisMac(daemon({ installedVersion: "0.5.0", updateAvailable: false })),
  machine(
    "pi",
    "Raspberry Pi",
    "lucas-rpi",
    connected("linux-arm64", "0.4.1", 38),
    failed(
      {
        kind: "host-setup",
        message: "The daemon needs glibc 2.31 or newer; this host has 2.28.",
        command: "sudo apt-get install --only-upgrade libc6",
        sshFailure: null,
      },
      now
    )
  ),
  machine(
    "vm",
    "Build VM",
    "build-vm",
    connected("linux-x64", "0.4.1", 61),
    failed({ kind: "ssh", message: "", command: null, sshFailure: "host-key" }, now)
  ),
  machine(
    "nuc",
    "NUC",
    "nuc",
    connected("linux-x64", "0.4.1", 12),
    failed(
      {
        kind: "ssh",
        message: "lucas@nuc: Permission denied (publickey).",
        command: null,
        sshFailure: "auth",
      },
      now
    )
  ),
  machine(
    "Debian",
    "Debian",
    "Debian",
    attention("wsl-missing", "wsl.exe: not found"),
    daemon({ installedVersion: "0.4.0" }),
    "wsl"
  ),
  machine(
    "Fedora",
    "Fedora",
    "Fedora",
    attention("wsl-distro-missing", "There is no distribution with the supplied name."),
    daemon({ installedVersion: "0.4.0" }),
    "wsl"
  ),
  machine(
    "box",
    "Storage box",
    "storage",
    connected("linux-x64", "0.4.1", 90),
    failed(
      {
        kind: "failed",
        message: "SHA-256 didn't match after copying: 9f2c… ≠ 41ab…",
        command: null,
        sshFailure: null,
      },
      now
    )
  ),
];

/** Everything current, the app-wide switch off, one host kept up to date on its own. */
const current = (): ReadonlyArray<MachineView> => [
  thisMac(
    daemon({
      installedVersion: "0.5.0",
      updateAvailable: false,
      keepDaemonsUpToDate: false,
      keepUpToDate: false,
    })
  ),
  machine(
    "studio",
    "Mac Studio",
    "studio",
    connected("darwin-arm64", "0.5.0", 4),
    daemon({
      installedVersion: "0.5.0",
      updateAvailable: false,
      keepDaemonsUpToDate: false,
      keepUpToDateOverride: true,
    })
  ),
  machine(
    "pi",
    "Raspberry Pi",
    "lucas-rpi",
    connected("linux-arm64", "0.5.0", 38),
    daemon({
      installedVersion: "0.5.0",
      updateAvailable: false,
      keepDaemonsUpToDate: false,
      keepUpToDate: false,
    })
  ),
];

/** "live" starts as two offers; Update walks the preview through checking, copying and switching. */
const live = (): ReadonlyArray<MachineView> => [
  thisMac(daemon({ installedVersion: "0.5.0", updateAvailable: false })),
  machine(
    "studio",
    "Mac Studio",
    "studio",
    connected("darwin-arm64", "0.4.1", 4),
    daemon({ keepUpToDateOverride: false, keepUpToDate: false })
  ),
  machine("pi", "Raspberry Pi", "lucas-rpi", connected("linux-arm64", "0.4.1", 38), daemon()),
];

/** A Windows PC (Paper W1–W2): WSL Hosts connected, with wsl.exe gone, and with the distro gone. */
const wsl = (): ReadonlyArray<MachineView> => [
  machine(
    "local",
    "Lucas's PC",
    null,
    connected("linux-x64", "0.5.0", null),
    daemon({ installedVersion: "0.5.0", updateAvailable: false })
  ),
  machine(
    "Ubuntu",
    "Ubuntu",
    "Ubuntu",
    connected("linux-x64", "0.5.0", 2),
    daemon({ installedVersion: "0.5.0", updateAvailable: false }),
    "wsl"
  ),
  machine(
    "Debian",
    "Debian",
    "Debian",
    attention("wsl-missing", "wsl.exe: not found"),
    daemon({ installedVersion: "0.5.0", updateAvailable: false }),
    "wsl"
  ),
  machine(
    "Fedora",
    "Fedora",
    "Fedora",
    attention("wsl-distro-missing", "There is no distribution with the supplied name."),
    daemon({ installedVersion: "0.5.0", updateAvailable: false }),
    "wsl"
  ),
];

/** An install stopped on a sign-in task another Polaris home (or another program) holds. */
const heldTask = (view: MachineView, otherHome: string | null): MachineView => ({
  ...view,
  install: {
    step: "blocked",
    activity: null,
    offer: null,
    outcome: null,
    problem: {
      kind: "task-conflict",
      message: "the scheduled task dev.lux.polaris.lucas runs another Polaris home",
      command: null,
      conflict: { task: "dev.lux.polaris.lucas", otherHome },
    },
  },
});

/** Windows: this PC's first install and a Windows SSH Host's upgrade, both held (ENG-325). */
const task = (): ReadonlyArray<MachineView> => [
  heldTask(
    machine(
      "local",
      "This PC",
      null,
      attention("polaris-not-installed", "polaris.exe: not found"),
      daemon({ installedVersion: null, updateAvailable: false })
    ),
    "C:\\Users\\lucas\\polaris-dev\\.polaris"
  ),
  {
    ...heldTask(
      machine(
        "pc",
        "Gaming PC",
        "lucas-desktop",
        connected("windows-x64", "0.4.1", 6),
        daemon({
          lastUpdate: {
            at: 0,
            result: "failed",
            from: "0.4.1",
            version: null,
            problem: {
              kind: "task-conflict",
              message: "the scheduled task dev.lux.polaris.lucas is not your Polaris task",
              command: null,
              sshFailure: null,
            },
          },
        })
      ),
      null
    ),
    windowsShell: "powershell",
  },
];

/** What "Add a host" is offered on the `wsl` scene; the other scenes are Macs (no WSL). */
export const WSL_DISTROS: WslDistrosView = {
  status: "distros",
  distros: [
    { name: "Ubuntu", version: 2, state: "running", isDefault: true, unsupported: null },
    { name: "Debian", version: 2, state: "stopped", isDefault: false, unsupported: null },
    { name: "Alpine", version: 2, state: "stopped", isDefault: false, unsupported: null },
    {
      name: "Legacy",
      version: 1,
      state: "stopped",
      isDefault: false,
      unsupported: "WSL 1: convert it with wsl --set-version first",
    },
  ],
  detail: null,
};

export const SSH_ALIASES: ReadonlyArray<SshAliasView> = [
  { alias: "studio", hostName: "studio.lan", user: "lucas" },
  { alias: "work-vm", hostName: "10.0.0.12", user: "lucas" },
];

const reconnecting = (now: number): ConnectionStatusView => ({
  ...offline(now),
  state: "reconnecting",
  since: now - 12_000,
  lastSeenAt: now - 12_000,
});

const coloured = (view: MachineView, colour: string): MachineView => ({ ...view, colour });

/** HS-D2: every Connection State in the redesigned list, each host in its own colour. */
const states = (now: number): ReadonlyArray<MachineView> => {
  const current = daemon({ installedVersion: "0.5.0", updateAvailable: false });

  const later = (patch: Partial<ConnectionStatusView>) => ({
    ...offline(now),
    lastSeenAt: now - 2 * 60 * MINUTE,
    ...patch,
  });

  return [
    coloured(thisMac(current), "#E3E4E8"),
    coloured(
      machine(
        "studio",
        "Mac Studio",
        "lucas-mac-studio",
        connected("darwin-arm64", "0.5.0", 47),
        current
      ),
      "#8FB0E8"
    ),
    coloured(
      machine("pi", "Raspberry Pi 4", "lucas-rpi", connected("linux-arm64", "0.5.0", 118), current),
      "#7FCF9A"
    ),
    coloured(machine("vm", "Linux VM", "devbox", reconnecting(now), current), "#A797D9"),
    coloured(machine("build", "Build box", "buildbox", later({}), current), "#C4A27A"),
  ];
};

export const machinesFor = (scene: Scene, now: number): ReadonlyArray<MachineView> => {
  switch (scene) {
    case "states":
      return states(now);
    case "wsl":
      return wsl();
    case "task":
      return task();
    case "current":
      return current();
    case "failures":
      return failures(now);
    case "live":
      return live();
    default:
      return all(now);
  }
};
