import { expect, test } from "bun:test";
import { join } from "node:path";
import { tempDir } from "../platform/tempDir.testing.ts";
import { BootedStore } from "./bootedStore.ts";
import { Inventory } from "./inventory.ts";

const ID = "AAAAAAAA-0000-0000-0000-000000000001";

test("a boot Polaris made is kept until the Simulator is seen booted and then shut down", async () => {
  let booted = false;
  const store = new BootedStore(join(tempDir("simbooted-"), "booted.json"));

  const inventory = new Inventory({
    ready: async () => ({ ios: true, android: false }),
    listIos: async () => ({
      simulators: [{ id: ID, name: "polaris-test", version: "iOS 27.0", booted }],
      emulators: [],
    }),
    listHub: async () => null,
    booted: store,
    pollMs: 60_000,
    log: () => undefined,
  });

  await inventory.refresh();

  // The boot returned, but `simctl` doesn't say Booted yet.
  store.add(ID);
  await inventory.refresh();
  expect(store.has(ID)).toBe(true);

  booted = true;
  await inventory.refresh();
  expect(inventory.find(ID)?.bootedByPolaris).toBe(true);

  booted = false;
  await inventory.refresh();
  expect(store.has(ID)).toBe(false);
});
