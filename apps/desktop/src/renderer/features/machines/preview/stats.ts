/**
 * The Hosts preview's fake `host.stats` feed and Restart daemon answers: a deterministic CPU
 * wave per host, a sample every 2s, and a restart that comes back on Mac Studio and fails on
 * the Raspberry Pi. Nothing is sampled or restarted.
 */
import { HostDiskUsage, HostStatsItem, HostStatsSample } from "@polaris/protocol";
import type { RestartDaemonResult, RestartPreviewView } from "../../../../shared/restart.ts";

const INTERVAL = 2000;

const GIB = 1024 ** 3;

const PROFILE = new Map([
  ["local", { base: 6, cores: 12, memory: 36 }],
  ["studio", { base: 34, cores: 24, memory: 128 }],
  ["pi", { base: 58, cores: 4, memory: 8 }],
]);

const sampleAt = (hostKey: string, i: number, at: number) => {
  const p = PROFILE.get(hostKey) ?? { base: 20, cores: 8, memory: 16 };
  const wave = Math.sin(i / 5) * 12 + Math.sin(i / 1.7 + hostKey.length) * 6;
  const cpu = Math.max(1, Math.min(99, p.base + wave + (i % 23 === 7 ? 40 : 0)));
  const load = (cpu / 100) * p.cores;

  return HostStatsSample.make({
    at: new Date(at).toISOString(),
    cpuPercent: cpu,
    loadAverage: [load, load * 0.92, load * 0.85],
    memoryUsedBytes: Math.round(p.memory * GIB * 0.32),
    memoryTotalBytes: p.memory * GIB,
    disk: HostDiskUsage.make({
      path: "/Users/lucas/.polaris",
      usedBytes: 1.2e12,
      totalBytes: 2e12,
    }),
  });
};

/** `History` with 60 samples, then one `Sample` per interval until closed. */
export const fakeStats = (hostKey: string, emit: (items: ReadonlyArray<HostStatsItem>) => void) => {
  const start = Date.now() - 60 * INTERVAL;
  let i = 60;
  const cores = PROFILE.get(hostKey)?.cores ?? 8;
  const history = Array.from({ length: 60 }, (_, n) => sampleAt(hostKey, n, start + n * INTERVAL));

  queueMicrotask(() =>
    emit([HostStatsItem.cases.History.make({ cores, intervalMs: INTERVAL, samples: history })])
  );

  const timer = setInterval(() => {
    i += 1;
    emit([HostStatsItem.cases.Sample.make({ sample: sampleAt(hostKey, i, Date.now()) })]);
  }, INTERVAL);

  return () => clearInterval(timer);
};

export const RESTART_PREVIEW: RestartPreviewView = {
  available: true,
  unavailableReason: null,
  interrupts: {
    workingSessions: [
      { sessionId: "s1", title: "Spike GPUI review", harness: "claude", turn: 12 },
      { sessionId: "s2", title: "Wire protocol frames", harness: "codex", turn: 4 },
      { sessionId: "s3", title: "Bench the event store", harness: "claude", turn: 3 },
    ],
    terminals: 2,
    pendingApprovals: 1,
  },
};

/** Studio comes back after a few seconds; the Pi's launchd can't start it again. */
export const restartOutcome = (hostKey: string): RestartDaemonResult =>
  hostKey === "pi"
    ? {
        outcome: "failed",
        stage: "start",
        message: "the daemon on Raspberry Pi 4 didn't come back",
        manager: "systemd",
        command: "systemctl --user restart polaris",
        output:
          "Job for polaris.service failed because the control process exited with error code.",
        exitCode: 1,
        reinstall: true,
      }
    : {
        outcome: "back",
        manager: "launchd",
        command: "launchctl kickstart -k gui/501/dev.lux.polaris",
        previousStartedAt: "2026-09-29T00:00:00.000Z",
        startedAt: new Date().toISOString(),
        interruptedTurns: 2,
      };

/** How long the preview's restart takes, so Restarting can be seen. */
export const RESTART_MS = 6000;
