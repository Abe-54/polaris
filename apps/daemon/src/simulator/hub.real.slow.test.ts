/**
 * The Simulator RPCs against a real expo-device-hub and a throwaway iOS Simulator
 * (`polaris-test-<random>`), created here and always deleted. Skipped without Xcode's Simulator.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SessionId, type SimulatorAttachItem, type SimulatorWatchItem } from "@polaris/protocol";
import { Effect, Fiber, Layer, Option, Predicate, Schema, Stream } from "effect";
import { everySessionLive } from "../browser/relaySessions.ts";
import { bunRuntime, installSimulatorTools } from "../install/simulator/install.ts";
import { HostPlatform } from "../platform/index.ts";
import { tempDir } from "../platform/tempDir.testing.ts";
import { SimulatorHub } from "./hub.ts";
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
const settledBarrier = async (endpoint: SimulatorAttachItem, id: string) => {
  const deadline = Date.now() + 60_000;
  let verdict = await inputBarrier(endpoint, id);

  // Each attempt waits on the hub (admission, config, barrier), so no sleep between them.
  while (verdict === "unknown" && Date.now() < deadline) verdict = await inputBarrier(endpoint, id);

  return verdict;
};

const isSnapshot = (item: SimulatorWatchItem) => Predicate.isTagged(item, "Snapshot");

describe.skipIf(target === null)("SimulatorHub on a real hub", () => {
  test("watch, boot, attach, restart, shutdown and the idle stop", async () => {
    const { runtime, deviceType } = target!;
    const name = `polaris-test-${crypto.randomUUID().slice(0, 8)}`;
    const created = simctl("create", name, deviceType, runtime);
    expect(created.ok).toBe(true);
    const id = created.out;

    try {
      const installed = await installSimulatorTools({ root: tempDir("sim-tools-") });
      const runtimeCommand = bunRuntime();

      const layer = SimulatorHub.layerWith({
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
            expect(yield* Effect.promise(() => settledBarrier(first, id))).toBe("live");

            yield* hub.restart;
            yield* Effect.promise(() => until(() => items.length === 2, 120_000));
            expect(items[1]!.token).not.toBe(first.token);
            expect(yield* Effect.promise(() => settledBarrier(items[1]!, id))).toBe("live");

            // Detached and idle: the hub stops and shuts down the Simulator Polaris booted.
            yield* Fiber.interrupt(attach);
            const supervisor = SimulatorHub.testing.supervisorOf(hub)!;
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
});
