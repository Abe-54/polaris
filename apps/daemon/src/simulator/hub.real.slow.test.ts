/**
 * The Simulator RPCs against a real expo-device-hub and a throwaway iOS Simulator
 * (`polaris-test-<random>`), created here and always deleted. Skipped without Xcode's Simulator.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SessionId, type SimulatorAttachItem, type SimulatorWatchItem } from "@polaris/protocol";
import { Effect, Fiber, Layer, Option, Predicate, Schedule, Schema, Stream } from "effect";
import { everySessionLive } from "../browser/relaySessions.ts";
import { bunRuntime, installSimulatorTools } from "../install/simulator/install.ts";
import { HostPlatform } from "../platform/index.ts";
import { tempDir } from "../platform/tempDir.testing.ts";
import { SimulatorHub, SimulatorHubLive } from "./hub.ts";
import { inputBarrier } from "./hubClient.ts";
import { iosReadyDetection, until } from "./hub.testing.ts";
import { liveProbe } from "./index.ts";
import { listLocalIos } from "./localDevices.ts";

const SESSION = SessionId.make("ses_simulator_real");

const Runtimes = Schema.fromJsonString(
  Schema.Struct({
    runtimes: Schema.Array(
      Schema.Struct({
        identifier: Schema.String,
        isAvailable: Schema.Boolean,
        supportedDeviceTypes: Schema.Array(
          Schema.Struct({ identifier: Schema.String, name: Schema.String })
        ),
      })
    ),
  })
);

const simctl = (...args: ReadonlyArray<string>) => {
  const proc = Bun.spawnSync(["/usr/bin/xcrun", "simctl", ...args]);

  return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim() };
};

/** An available iOS runtime and an iPhone it supports, or null when this Host has none. */
const iphoneTarget = () => {
  if (process.platform !== "darwin") return null;
  const listed = simctl("list", "runtimes", "--json");

  if (!listed.ok) return null;

  for (const runtime of Schema.decodeUnknownSync(Runtimes)(listed.out).runtimes) {
    const iphone = runtime.supportedDeviceTypes.find((type) => type.name.startsWith("iPhone"));

    if (runtime.isAvailable && runtime.identifier.includes(".iOS-") && iphone !== undefined)
      return { runtime: runtime.identifier, deviceType: iphone.identifier };
  }

  return null;
};

const target = iphoneTarget();

const stateOf = (id: string) =>
  listLocalIos(liveProbe().run).then((devices) =>
    devices?.simulators.find((simulator) => simulator.id === id)
  );

/** A fresh boot may refuse input for a moment (close 1013): "unknown" until it admits. */
const settledBarrier = (endpoint: SimulatorAttachItem, id: string) =>
  Effect.promise(() => inputBarrier(endpoint, id)).pipe(
    Effect.filterOrFail((verdict) => verdict !== "unknown"),
    // Spaced: the hub refuses a ninth input socket, so back-to-back retries would keep it full.
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
    Effect.orElseSucceed(() => "unknown" as const)
  );

const isSnapshot = (item: SimulatorWatchItem) => Predicate.isTagged(item, "Snapshot");

/** The hub service on a real expo-device-hub, idling out after 3 s. */
const realHub = async () => {
  const installed = await installSimulatorTools({ root: tempDir("sim-tools-") });
  const runtimeCommand = bunRuntime();

  return SimulatorHubLive.layerWith({
    dir: join(tempDir("simhub-", { short: true }), "home"),
    command: Effect.succeed({
      argv: [...runtimeCommand.argv, installed.hub],
      env: runtimeCommand.env,
    }),
    listIos: () => listLocalIos(liveProbe().run),
    sessions: everySessionLive,
    timing: {
      idleMs: 3_000,
      stopGraceMs: 60_000,
      wedgeCheckMs: 5_000,
      backoffMs: [1_000],
      healthyMs: 60_000,
    },
    pollMs: 1_000,
  }).pipe(Layer.provide(Layer.merge(HostPlatform.live, iosReadyDetection)));
};

describe.skipIf(target === null)("SimulatorHub on a real hub", () => {
  test("watch, boot, attach, restart, shutdown and the idle stop", async () => {
    const { runtime, deviceType } = target!;
    const name = `polaris-test-${crypto.randomUUID().slice(0, 8)}`;
    const created = simctl("create", name, deviceType, runtime);
    expect(created.ok).toBe(true);
    const id = created.out;

    try {
      const layer = await realHub();

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const hub = yield* SimulatorHub;
            const head = Option.getOrThrow(yield* Stream.runHead(hub.watch));
            expect(isSnapshot(head)).toBe(true);
            const listed = isSnapshot(head) ? head.simulators : [];
            expect(listed.find((s) => s.id === id)?.state).toBe("Shutdown");

            yield* hub.boot(id);
            expect((yield* Effect.promise(() => stateOf(id)))?.booted).toBe(true);

            const items: Array<SimulatorAttachItem> = [];

            const attach = yield* hub.attach(SESSION, id).pipe(
              Stream.runForEach((item) => Effect.sync(() => items.push(item))),
              Effect.forkScoped
            );

            yield* Effect.promise(() => until(() => items.length === 1, 120_000));
            const first = items[0]!;
            expect(yield* settledBarrier(first, id)).toBe("live");

            yield* hub.restart;
            yield* Effect.promise(() => until(() => items.length === 2, 120_000));
            expect(items[1]!.token).not.toBe(first.token);
            expect(yield* settledBarrier(items[1]!, id)).toBe("live");

            // Detached and idle: the hub stops and shuts down the Simulator Polaris booted.
            yield* Fiber.interrupt(attach);
            const supervisor = SimulatorHubLive.testing.supervisorOf(hub)!;
            yield* Effect.promise(() => until(() => supervisor.pid === null, 180_000));
            expect((yield* Effect.promise(() => stateOf(id)))?.booted).toBe(false);

            yield* hub.boot(id);
            yield* hub.shutdown(id, false);
            expect((yield* Effect.promise(() => stateOf(id)))?.booted).toBe(false);
          })
        ).pipe(Effect.provide(layer))
      );
    } finally {
      simctl("shutdown", id);
      simctl("delete", id);
    }

    expect(simctl("list", "devices").out).not.toContain(name);
  }, 900_000);
  test("a Simulator an agent booted with no hub running shuts down at idle", async () => {
    const { runtime, deviceType } = target!;
    const name = `polaris-test-${crypto.randomUUID().slice(0, 8)}`;
    const created = simctl("create", name, deviceType, runtime);
    expect(created.ok).toBe(true);
    const id = created.out;

    try {
      // agent-device boots with simctl, never through the hub.
      expect(simctl("boot", id).ok).toBe(true);
      const layer = await realHub();

      await Effect.runPromise(
        Effect.gen(function* () {
          const hub = yield* SimulatorHub;
          yield* hub.agentBooted(id);
          yield* Effect.promise(() =>
            until(() => simctl("list", "devices").out.includes(`${id}) (Shutdown)`), 300_000)
          );
          const supervisor = SimulatorHubLive.testing.supervisorOf(hub)!;
          yield* Effect.promise(() => until(() => supervisor.pid === null, 120_000));
        }).pipe(Effect.provide(layer))
      );
    } finally {
      simctl("shutdown", id);
      simctl("delete", id);
    }

    expect(simctl("list", "devices").out).not.toContain(name);
  }, 900_000);
});
