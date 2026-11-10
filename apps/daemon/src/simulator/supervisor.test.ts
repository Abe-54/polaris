import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_HUB_TIMING, HubSupervisor, hubTimingFromEnv } from "./supervisor.ts";
import { until } from "./hub.testing.ts";

// The fake hub's waits (`until`) allow 10 s on a loaded run.
setDefaultTimeout(20_000);

describe("hubTimingFromEnv", () => {
  test("POLARIS_SIMULATOR_IDLE_MS shortens the idle stop and nothing else", () => {
    expect(hubTimingFromEnv({ POLARIS_SIMULATOR_IDLE_MS: "4000" })).toEqual({
      ...DEFAULT_HUB_TIMING,
      idleMs: 4000,
    });
  });

  test.each(["", "0", "-5", "1.5", "soon"])("%p keeps the 5 minute default", (value) => {
    expect(hubTimingFromEnv({ POLARIS_SIMULATOR_IDLE_MS: value }).idleMs).toBe(5 * 60_000);
  });
});

describe("HubSupervisor's idle stop with no hub running", () => {
  test("an agent call starts nothing when Polaris booted no Simulator", async () => {
    let asked = false;
    let spawned = 0;

    const supervisor = new HubSupervisor({
      spawn: () => {
        spawned += 1;

        return Promise.reject(new Error("never started in this test"));
      },
      probe: () => Promise.resolve(true),
      beforeIdleStop: () => Promise.resolve(),
      ownsBooted: () => {
        asked = true;

        return false;
      },
      log: () => undefined,
      timing: { ...DEFAULT_HUB_TIMING, idleMs: 1 },
    });

    supervisor.touch();
    await until(() => asked);
    await supervisor.close();
    expect(spawned).toBe(0);
  });
});
