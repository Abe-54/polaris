import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { HostPlatform } from "../../platform/index.ts";
import type { InstalledSimulatorTools } from "./install.ts";
import { ownBun, SimulatorTools, type SimulatorToolsInstaller } from "./index.ts";

const INSTALLED: InstalledSimulatorTools = {
  dir: "/tools/x",
  hub: "/tools/x/hub",
  agentDevice: "/tools/x/ad",
  bun: ownBun(),
};

const counting = () => {
  let installs = 0;

  const installer: SimulatorToolsInstaller = {
    onDisk: async () => null,
    install: async () => {
      installs += 1;
      await Bun.sleep(5);

      return INSTALLED;
    },
  };

  return { installer, installs: () => installs };
};

const run = <A, E>(
  platform: Parameters<typeof HostPlatform.test>[0],
  installer: SimulatorToolsInstaller,
  use: (tools: SimulatorTools["Service"]) => Effect.Effect<A, E>
) =>
  Effect.runPromiseExit(
    Effect.flatMap(SimulatorTools, use).pipe(
      Effect.provide(
        SimulatorTools.layerWith(() => ({ root: "/unused" }), installer, {
          attemptTimeoutMs: 5_000,
          retryDelaysMs: [],
        }).pipe(Layer.provide(HostPlatform.test(platform)))
      )
    )
  );

describe("SimulatorTools", () => {
  test("a Host that can't run Simulators (the Pi) never installs them", async () => {
    const t = counting();
    const exit = await run({ os: "linux", arch: "arm64" }, t.installer, (tools) => tools.ensure);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(t.installs()).toBe(0);
  });

  test("callers on a Mac share one install and wait for it", async () => {
    const t = counting();

    const exit = await run({ os: "darwin", arch: "arm64", libc: "none" }, t.installer, (tools) =>
      Effect.all([tools.ensure, tools.ensure, tools.ensure], { concurrency: "unbounded" })
    );

    expect(exit).toEqual(Exit.succeed([INSTALLED, INSTALLED, INSTALLED]));
    expect(t.installs()).toBe(1);
  });

  test("current never waits: it fails while installing, then returns the install", async () => {
    const t = counting();

    const exit = await run({ os: "darwin", arch: "arm64", libc: "none" }, t.installer, (tools) =>
      Effect.gen(function* () {
        const first = yield* Effect.exit(tools.current);
        yield* Effect.promise(() => Bun.sleep(20));

        return { first, later: yield* tools.current };
      })
    );

    expect(Exit.isSuccess(exit) && Exit.isFailure(exit.value.first)).toBe(true);
    expect(Exit.isSuccess(exit) && exit.value.later).toEqual(INSTALLED);
    expect(t.installs()).toBe(1);
  });
});
