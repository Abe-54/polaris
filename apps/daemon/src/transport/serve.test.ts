import { expect, test } from "bun:test";
import { daemonCapabilities } from "./serve.ts";

// The Desktop App's Settings → Devices and each Host's Relay route hide themselves without it.
test("the Daemon announces linked-devices, so Clients offer the Relay route and Linked Devices", () => {
  expect(daemonCapabilities).toContain("linked-devices");
});

test("the mounted Data execution services advertise the Data capability", () => {
  expect(daemonCapabilities).toContain("data");
});
