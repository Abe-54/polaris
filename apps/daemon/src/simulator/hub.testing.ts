/** A `SimulatorHub` over the fake hub process (`fakeHub.testing.ts`), with fast timing. */
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SimulatorSupport } from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { everySessionLive, type SessionLookup } from "../browser/relaySessions.ts";
import { HostPlatform } from "../platform/index.ts";
import { newTempDir } from "../platform/tempDir.testing.ts";
import { SimulatorHub, SimulatorHubLive } from "./hub.ts";
import { SimulatorDetection } from "./index.ts";

export const OURS = "AAAAAAAA-0000-0000-0000-000000000001";

export const USERS = "AAAAAAAA-0000-0000-0000-000000000002";

const FAKE_HUB = join(import.meta.dir, "fakeHub.testing.ts");

const ready = SimulatorSupport.cases.Ready.make({});

export const EMULATOR = "emulator-5554";

const detectionWith = (android: boolean) => {
  const report = {
    support: { ios: ready, android: android ? ready : SimulatorSupport.cases.Unsupported.make({}) },
    iosBlocked: null,
    androidSdk: android ? "/fake/android-sdk" : null,
  };

  return Layer.succeed(
    SimulatorDetection,
    SimulatorDetection.of({
      current: Effect.succeed(report),
      refresh: Effect.succeed(report),
      changes: Stream.never,
    })
  );
};

/** Detection that reports iOS ready and Android unsupported. */
export const iosReadyDetection = detectionWith(false);

export interface FakeHost {
  readonly dir: string;
  readonly log: () => ReadonlyArray<string>;
  readonly wedge: (on: boolean) => void;
  readonly booted: (id: string) => boolean;
  /** Boots `id` behind the hub's back, as agent-device does. */
  readonly bootOutside: (id: string) => void;
  /** While on, `simctl` lists what it listed when turned on, as one lagging behind a boot does. */
  readonly stale: (on: boolean) => void;
  readonly layer: (sessions?: SessionLookup) => Layer.Layer<SimulatorHub>;
}

/**
 * One booted Simulator the user started, one shut down that Polaris may boot; with `android`,
 * Android is ready too and the hub lists one shut-down emulator.
 */
export const fakeHost = (idleMs = 300, { android = false } = {}): FakeHost => {
  const dir = newTempDir("simhub-", { short: true });
  const devices = join(dir, "devices.json");
  const logPath = join(dir, "hub-events.log");
  const wedgePath = join(dir, "wedged");
  writeFileSync(logPath, "");
  writeFileSync(
    devices,
    JSON.stringify({
      simulators: [
        { id: OURS, name: "polaris-test-ours", version: "iOS 27.0", booted: false },
        { id: USERS, name: "The user's iPhone", version: "iOS 27.0", booted: true },
      ],
      emulators: android
        ? [{ id: EMULATOR, name: "Pixel_9_API_36", version: "36", booted: false }]
        : [],
    })
  );

  let frozen: ReturnType<typeof read> | null = null;

  const read = () =>
    // SAFETY: only this file and the fake hub write `devices.json`, in this shape.
    JSON.parse(readFileSync(devices, "utf8")) as {
      simulators: Array<{ id: string; name: string; version: string; booted: boolean }>;
      emulators: Array<{ id: string; name: string; version: string; booted: boolean }>;
    };

  return {
    dir,
    log: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean),
    wedge: (on) => (on ? writeFileSync(wedgePath, "") : rmSync(wedgePath, { force: true })),
    booted: (id) => {
      const { simulators, emulators } = read();

      return [...simulators, ...emulators].find((device) => device.id === id)?.booted === true;
    },
    bootOutside: (id) => {
      const current = read();

      writeFileSync(
        devices,
        JSON.stringify({
          ...current,
          simulators: current.simulators.map((d) => (d.id === id ? { ...d, booted: true } : d)),
        })
      );
    },
    stale: (on) => {
      frozen = on ? read() : null;
    },
    layer: (sessions = everySessionLive) =>
      SimulatorHubLive.layerWith({
        dir: join(dir, "home"),
        command: Effect.succeed({
          argv: [process.execPath, FAKE_HUB],
          env: { FAKE_HUB_DEVICES: devices, FAKE_HUB_LOG: logPath, FAKE_HUB_WEDGE: wedgePath },
        }),
        listIos: async () => ({ ...(frozen ?? read()), emulators: [] }),
        sessions,
        timing: {
          idleMs,
          stopGraceMs: 2_000,
          wedgeCheckMs: 100,
          backoffMs: [50],
          healthyMs: 60_000,
        },
        pollMs: 50,
        startTimeoutMs: 5_000,
      }).pipe(
        Layer.provide(
          Layer.merge(
            HostPlatform.test({ os: "darwin", arch: "arm64", libc: "none" }),
            detectionWith(android)
          )
        )
      ),
  };
};

/** Polls `check` every 10 ms until it holds, failing after `timeoutMs`: generous, for a loaded test run. */
export const until = async (check: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
};

export const alive = (pid: number | null) => {
  if (pid === null) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/**
 * Every hub the fake started has exited, and one did. By pid, not its `term` line: Windows ends
 * a process on SIGTERM without running its handler.
 */
export const hubsStopped = (log: ReadonlyArray<string>) => {
  const pids = log.flatMap((line) => (line.startsWith("start ") ? [Number(line.slice(6))] : []));

  return pids.length > 0 && pids.every((pid) => !alive(pid));
};
