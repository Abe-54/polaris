/**
 * The hub's `GET /api/devices` as Polaris Simulators. Its `errors` are objects holding stack
 * traces with the Host's paths (one on every Mac without the Android SDK): they never reach a Client.
 */
import { Simulator, type SimulatorPlatform } from "@polaris/protocol";
import { Schema } from "effect";

const HubDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** "iOS 27.1", or the emulator's API level. */
  version: Schema.optional(Schema.String),
  booted: Schema.Boolean,
});

export const HubDevices = Schema.Struct({
  simulators: Schema.Array(HubDevice),
  emulators: Schema.Array(HubDevice),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});

export type HubDevices = typeof HubDevices.Type;

const simulatorOf =
  (platform: SimulatorPlatform, bootedByPolaris: ReadonlySet<string>) =>
  (device: typeof HubDevice.Type) =>
    new Simulator({
      id: device.id,
      platform,
      name: device.name,
      osVersion: device.version ?? "",
      state: device.booted ? "Booted" : "Shutdown",
      bootedByPolaris: device.booted && bootedByPolaris.has(device.id),
    });

const named = (device: typeof HubDevice.Type) => device.id !== "";

/** The devices, and only how many errors the hub reported, for the Daemon's log. */
export const simulatorsFromHub = (devices: HubDevices, bootedByPolaris: ReadonlySet<string>) => ({
  simulators: [
    ...devices.simulators.filter(named).map(simulatorOf("ios", bootedByPolaris)),
    ...devices.emulators.filter(named).map(simulatorOf("android", bootedByPolaris)),
  ],
  errorCount: devices.errors?.length ?? 0,
});
