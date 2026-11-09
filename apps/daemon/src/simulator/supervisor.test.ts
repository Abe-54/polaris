import { describe, expect, test } from "bun:test";
import { DEFAULT_HUB_TIMING, hubTimingFromEnv } from "./supervisor.ts";

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
