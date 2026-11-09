/** A `SimulatorHub` over the fake hub process (`fakeHub.testing.ts`), with fast timing. */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SimulatorSupport } from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { everySessionLive, type SessionLookup } from "../browser/relaySessions.ts";
import { HostPlatform } from "../platform/index.ts";
import { SimulatorHub } from "./hub.ts";
import { SimulatorDetection } from "./index.ts";

export const OURS = "AAAAAAAA-0000-0000-0000-000000000001";

export const USERS = "AAAAAAAA-0000-0000-0000-000000000002";

const FAKE_HUB = join(import.meta.dir, "fakeHub.testing.ts");

const ready = SimulatorSupport.cases.Ready.make({});

const detection = Layer.succeed(
  SimulatorDetection,
  SimulatorDetection.of({
    current: Effect.succeed({
      support: { ios: ready, android: SimulatorSupport.cases.Unsupported.make({}) },
      iosBlocked: null,
      androidSdk: null,
    }),
    refresh: Effect.succeed({
      support: { ios: ready, android: SimulatorSupport.cases.Unsupported.make({}) },
      iosBlocked: null,
      androidSdk: null,
    }),
    changes: Stream.never,
  })
);

export interface FakeHost {
  readonly dir: string;
  readonly log: () => ReadonlyArray<string>;
  readonly wedge: (on: boolean) => void;
  readonly booted: (id: string) => boolean;
  readonly layer: (sessions?: SessionLookup) => Layer.Layer<SimulatorHub>;
}

/** One booted Simulator the user started, one shut down that Polaris may boot. */
export const fakeHost = (idleMs = 300): FakeHost => {
  const dir = mkdtempSync("/tmp/simhub-");
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
    })
  );

  const read = () =>
    // SAFETY: only this file and the fake hub write `devices.json`, in this shape.
    JSON.parse(readFileSync(devices, "utf8")) as {
      simulators: Array<{ id: string; name: string; version: string; booted: boolean }>;
    };

  return {
    dir,
    log: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean),
    wedge: (on) => (on ? writeFileSync(wedgePath, "") : rmSync(wedgePath, { force: true })),
    booted: (id) => read().simulators.find((device) => device.id === id)?.booted === true,
    layer: (sessions = everySessionLive) =>
      SimulatorHub.layerWith({
        dir: join(dir, "home"),
        command: Effect.succeed({
          argv: [process.execPath, FAKE_HUB],
          env: { FAKE_HUB_DEVICES: devices, FAKE_HUB_LOG: logPath, FAKE_HUB_WEDGE: wedgePath },
        }),
        listIos: async () => ({ ...read(), emulators: [] }),
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
          Layer.merge(HostPlatform.test({ os: "darwin", arch: "arm64", libc: "none" }), detection)
        )
      ),
  };
};

/** Polls `check` every 10 ms until it holds, failing after `timeoutMs`. */
export const until = async (check: () => boolean, timeoutMs = 3_000) => {
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
