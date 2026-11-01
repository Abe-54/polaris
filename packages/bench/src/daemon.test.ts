import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Effect } from "effect";
import { awaitReady, cleanup, type Daemon, launchDaemon } from "./daemon.ts";
import { runScenario } from "./runner.ts";
import { startupModules } from "./scenarios/cold-start.ts";

const ready = async (daemon: Daemon) => {
  const deadline = Date.now() + 30_000;

  while (!existsSync(daemon.socketPath)) {
    if (Date.now() > deadline) throw new Error(`Daemon socket did not appear\n${daemon.logs()}`);
    await Bun.sleep(20);
  }

  await Effect.runPromise(awaitReady(daemon));
};

test("fixture Daemon and bridge exclude inherited and overridden handoff", async () => {
  const previous = process.env.POLARIS_HANDOFF;
  process.env.POLARIS_HANDOFF = "parent-handoff";

  try {
    const daemon = await launchDaemon({
      binary: null,
      env: { POLARIS_HANDOFF: "override-handoff", POLARIS_FIXTURE_SETTING: "retained" },
    });

    try {
      expect(daemon.env.POLARIS_HANDOFF).toBeUndefined();
      expect(daemon.bridgeEnv.POLARIS_HANDOFF).toBeUndefined();
      expect(daemon.env.POLARIS_FIXTURE_SETTING).toBe("retained");
      expect(daemon.env.POLARIS_HOME).toBe(daemon.home);
      await ready(daemon);
    } finally {
      await daemon.stop();
      cleanup(daemon.home);
    }
  } finally {
    if (previous === undefined) delete process.env.POLARIS_HANDOFF;
    else process.env.POLARIS_HANDOFF = previous;
  }
}, 40_000);

test("a zero-process Daemon report fails the scenario visibly", async () => {
  const logs: Array<string> = [];

  const result = await runScenario(
    {
      name: "idle-missing-daemon",
      description: "a Daemon exits before the idle measurement",
      run: (ctx) =>
        Effect.gen(function* () {
          const daemon = yield* ctx.launch();
          yield* Effect.promise(() => ready(daemon));
          const sampler = yield* ctx.sample(daemon);
          expect(sampler.report().maxProcesses).toBeGreaterThan(0);
          yield* Effect.promise(() => daemon.stop());
          const from = sampler.now();
          const report = sampler.report(from, sampler.sample().t);

          return {
            metrics: {
              processes: { value: report.maxProcesses, unit: "", kind: "count", better: "lower" },
            },
            notes: [],
          };
        }),
    },
    {
      quick: true,
      runs: 1,
      binary: null,
      transport: "socket",
      developerMode: "off",
      clientSelfTraces: false,
      profileRoot: null,
      log: (message) => logs.push(message),
    }
  );

  expect(result.error).toContain("measured zero Daemon processes");
  expect(result.metrics).toEqual({});
  expect(logs.some((message) => message.includes("failed"))).toBe(true);
}, 40_000);

test("a Daemon with POLARIS_DEBUG_MODULES reports its start-up graph in the form cold-start reads", async () => {
  const daemon = await launchDaemon({ binary: null, env: { POLARIS_DEBUG_MODULES: "1" } });

  try {
    await ready(daemon);
    const deadline = Date.now() + 10_000;

    while (startupModules(daemon.logs()) === null && Date.now() < deadline) await Bun.sleep(20);
    const { all, polaris } = startupModules(daemon.logs()) ?? { all: 0, polaris: 0 };

    expect(polaris).toBeGreaterThan(100);
    expect(all).toBeGreaterThan(polaris);
  } finally {
    await daemon.stop();
    cleanup(daemon.home);
  }
}, 40_000);
