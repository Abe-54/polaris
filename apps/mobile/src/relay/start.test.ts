import { expect, test } from "bun:test";
import type { DeviceKeys, LinkedHost, RelayDevice } from "@polaris/client/relay";

import { startRelay } from "./start.ts";

for (const stop of [true, false]) {
  test(`relay startup ${stop ? "makes no device or ready delivery after stopping while keys open" : "delivers the created device and stored hosts when still mounted"}`, async () => {
    const opening = Promise.withResolvers<DeviceKeys>();
    const started = Promise.withResolvers<void>();
    let stopped = false;
    let devices = 0;
    const received: Array<Parameters<Parameters<typeof startRelay>[1]>> = [];
    let loaded = false;
    // SAFETY: startup only forwards keys and the device; this test never uses their internals.
    const keys = {} as DeviceKeys;
    // SAFETY: the ready callback observes device creation without opening a real socket.
    const device = {} as RelayDevice;

    const hosts: ReadonlyArray<LinkedHost> = [
      {
        hostId: "studio",
        hostName: "Studio",
        relayUrl: "wss://relay.test",
        // SAFETY: this 22-character base64url fixture has the RelayAddress format.
        hostAddress: "a".repeat(22) as LinkedHost["hostAddress"],
        hostNoiseKey: "b".repeat(43),
      },
    ];

    const startup = startRelay(
      () => stopped,
      (...args) => {
        received.push(args);
      },
      () => {
        loaded = true;
      },
      {
        loadSecrets: async () => ({
          identitySeed: new Uint8Array(32),
          noiseSecret: new Uint8Array(32),
        }),
        loadHosts: async () => hosts,
        deviceKeys: () => {
          started.resolve();

          return opening.promise;
        },
        makeRelayDevice: () => {
          devices++;

          return device;
        },
      }
    );

    await started.promise;
    stopped = stop;
    opening.resolve(keys);
    await startup;

    expect(devices).toBe(stop ? 0 : 1);
    expect(received).toEqual(stop ? [] : [[device, keys, hosts]]);
    expect(loaded).toBe(!stop);
  });
}
