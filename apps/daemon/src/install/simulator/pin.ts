/**
 * The Simulator's tools (ADR 0099): Expo's device hub (MIT, github.com/expo/expo-device-hub, tag
 * expo-device-hub@0.21.0 at commit c8255afb869287f307d8f80be17aa4067ff48aed), which vendors
 * serve-sim and serve-emu (Apache-2.0), and Callstack's agent-device (MIT). `bun.lock.txt` pins
 * every package with its npm sha512 integrity; a bump regenerates it (see the README).
 */
import lockfile from "./bun.lock.txt" with { type: "text" };

export const EXPO_DEVICE_HUB_VERSION = "0.21.0";

export const EXPO_DEVICE_HUB_COMMIT = "c8255afb869287f307d8f80be17aa4067ff48aed";

export const AGENT_DEVICE_VERSION = "0.21.36";

/** The install's directory name: a bump of either tool installs beside the old set. */
export const SIMULATOR_TOOLS_VERSION = `hub-${EXPO_DEVICE_HUB_VERSION}+agent-device-${AGENT_DEVICE_VERSION}`;

/** The `package.json` the lockfile was made from; `bun install --frozen-lockfile` refuses any other. */
export const SIMULATOR_TOOLS_MANIFEST = {
  name: "polaris-simulator-tools",
  private: true,
  dependencies: {
    "agent-device": AGENT_DEVICE_VERSION,
    "expo-device-hub": EXPO_DEVICE_HUB_VERSION,
  },
};

export const SIMULATOR_TOOLS_LOCKFILE: string = lockfile;

/** The scripts each tool runs, relative to the install's directory. */
export const SIMULATOR_TOOLS_ENTRIES = {
  hub: "node_modules/expo-device-hub/dist/server/cli.mjs",
  agentDevice: "node_modules/agent-device/bin/agent-device.mjs",
};
