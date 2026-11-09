/**
 * The Host's iOS Simulators from `xcrun simctl list devices --json`, without the hub: a
 * `simulator.watch` must not start it. Shaped as the hub's list, for `simulatorsFromHub`.
 */
import { Option, Schema } from "effect";
import type { HubDevices } from "./hubDevices.ts";
import type { SupportProbe } from "./support.ts";

const SimctlDevice = Schema.Struct({
  udid: Schema.String,
  name: Schema.String,
  state: Schema.String,
  isAvailable: Schema.optional(Schema.Boolean),
});

const SimctlList = Schema.fromJsonString(
  Schema.Struct({ devices: Schema.Record(Schema.String, Schema.Array(SimctlDevice)) })
);

const decodeList = Schema.decodeUnknownOption(SimctlList);

const RUNTIME = /SimRuntime\.iOS-(\d+)-(\d+)$/;

/** `com.apple.CoreSimulator.SimRuntime.iOS-27-1` is "iOS 27.1"; other platforms are null. */
export const iosVersionOf = (runtime: string): string | null => {
  const match = RUNTIME.exec(runtime);

  return match === null ? null : `iOS ${match[1]}.${match[2]}`;
};

export const parseSimctlList = (stdout: string): HubDevices | null => {
  const list = Option.getOrNull(decodeList(stdout));

  if (list === null) return null;

  const simulators = Object.entries(list.devices).flatMap(([runtime, devices]) => {
    const version = iosVersionOf(runtime);

    if (version === null) return [];

    return devices
      .filter((device) => device.isAvailable !== false)
      .map((device) => ({
        id: device.udid,
        name: device.name,
        version,
        booted: device.state === "Booted",
      }));
  });

  return { simulators, emulators: [] };
};

const LIST_TIMEOUT_MS = 60_000;

/** Null when `simctl` failed or timed out: the caller keeps what it knew. */
export const listLocalIos = async (run: SupportProbe["run"]): Promise<HubDevices | null> => {
  const result = await run(["xcrun", "simctl", "list", "devices", "--json"], LIST_TIMEOUT_MS);

  if (result === null || result === "timeout" || result.exitCode !== 0) return null;

  return parseSimctlList(result.stdout);
};
