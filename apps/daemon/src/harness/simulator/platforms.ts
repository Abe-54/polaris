/**
 * iOS Simulators and Android Emulators as agent-device names them: which selector binds a
 * device, how a listed device reads, and the platform an id belongs to.
 */
import { Schema } from "effect";

export const Platform = Schema.Literals(["ios", "android"]);

export type Platform = typeof Platform.Type;

export const PLATFORMS: ReadonlyArray<Platform> = ["ios", "android"];

/** A Simulator UDID; anything else (`emulator-5554`, an AVD name) is an Android device. */
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export const platformOf = (id: string): Platform => (UDID.test(id) ? "ios" : "android");

/** A running emulator's adb serial (`emulator-5554`, `127.0.0.1:5555`). */
const SERIAL = /^emulator-\d+$|:\d+$/;

/** The flags that bind a call to one device: a UDID, an adb serial, or an AVD's name. */
export const selectorOf = (platform: Platform, id: string): ReadonlyArray<string> => {
  if (platform === "ios") return ["--platform", "ios", "--udid", id];

  return ["--platform", "android", SERIAL.test(id) ? "--serial" : "--device", id];
};

export const LABEL: Record<Platform, string> = {
  ios: "iOS",
  android: "Android",
};

export const DeviceList = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      platform: Schema.String,
      model: Schema.optionalKey(Schema.String),
      osVersion: Schema.optionalKey(Schema.String),
      booted: Schema.optionalKey(Schema.Boolean),
    })
  ),
});

export type ListedDevice = (typeof DeviceList.Type)["devices"][number];

export const describeDevice = (platform: Platform, device: ListedDevice) =>
  [
    device.id,
    device.name,
    device.osVersion === undefined ? null : `${LABEL[platform]} ${device.osVersion}`,
    device.model,
    device.booted === true ? "booted" : "shut down",
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(" · ");

export const NONE_LISTED: Record<Platform, string> = {
  ios: "No iOS Simulators on this Host: create one in Xcode (Window > Devices and Simulators).",
  android:
    "No Android Emulators on this Host: create an Android Virtual Device in Android Studio's Device Manager.",
};

/** The slow part of a first open, said in the result rather than timing out. */
export const OPEN_SLOW: Record<Platform, string> = {
  ios: "The first open on this Host builds agent-device's iOS runner for this Xcode, which takes about a minute (more on a busy Mac).",
  android: "Booting an Android Emulator that isn't running takes a minute or two.",
};
