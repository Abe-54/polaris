import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { HubDevices, simulatorsFromHub } from "./hubDevices.ts";

/** As served on a Mac without the Android SDK (docs/research/2026-11-09-simulator-hub-spike.md). */
const SERVED = JSON.stringify({
  simulators: [
    {
      id: "FCE82B83-1",
      name: "iPhone Duo",
      version: "iOS 27.1",
      platform: "ios",
      booted: true,
      physical: false,
    },
    { id: "AB12-2", name: "iPhone 17 Pro", version: "iOS 27.0", platform: "ios", booted: false },
  ],
  emulators: [
    { id: "Pixel_9_API_36", name: "Pixel 9", version: "36", platform: "android", booted: false },
  ],
  errors: [
    {
      id: "9f9eabe0",
      message: "[android-utils] Failed to run `avdmanager list avd`:",
      error:
        "Error: ENOENT: spawn avdmanager\n    at /Users/someone/.polaris/tools/simulator/node_modules/x.mjs:1:1",
    },
  ],
});

const devices = Schema.decodeUnknownSync(Schema.fromJsonString(HubDevices))(SERVED);

describe("simulatorsFromHub", () => {
  test("maps both platforms and marks only booted ones Polaris booted", () => {
    const { simulators } = simulatorsFromHub(devices, new Set(["FCE82B83-1", "AB12-2"]));

    expect(
      simulators.map((s) => [s.platform, s.id, s.osVersion, s.state, s.bootedByPolaris])
    ).toEqual([
      ["ios", "FCE82B83-1", "iOS 27.1", "Booted", true],
      ["ios", "AB12-2", "iOS 27.0", "Shutdown", false],
      ["android", "Pixel_9_API_36", "36", "Shutdown", false],
    ]);
  });

  test("the hub's error objects, with their local paths, never reach the result", () => {
    const result = simulatorsFromHub(devices, new Set());

    expect(result.errorCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("avdmanager");
    expect(JSON.stringify(result)).not.toContain("/Users/");
  });
});
