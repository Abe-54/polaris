import { expect, test } from "bun:test";
import { daemonCapabilities } from "./serve.ts";

// Without linked-devices, the Desktop App's Settings → Devices and each Host's Relay route hide.
test.each(["linked-devices", "data"] as const)("the Daemon announces %s", (capability) => {
  expect(daemonCapabilities).toContain(capability);
});
