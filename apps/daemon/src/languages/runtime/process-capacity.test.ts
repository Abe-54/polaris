import { expect, test } from "bun:test";
import { deriveProcessLimit, reclaimableDarwinMemory } from "./process-capacity.ts";

const gib = 1024 ** 3;

test("measured memory envelope scales Mac, Pi, constrained and CPU-limited Hosts", () => {
  expect(
    deriveProcessLimit({
      cpuCount: 12,
      totalMemoryBytes: 32 * gib,
      availableMemoryBytes: 7.5 * gib,
    })
  ).toBe(19);
  expect(
    deriveProcessLimit({
      cpuCount: 4,
      totalMemoryBytes: 3881676 * 1024,
      availableMemoryBytes: 2945652 * 1024,
    })
  ).toBe(4);
  expect(
    deriveProcessLimit({ cpuCount: 1, totalMemoryBytes: gib, availableMemoryBytes: gib / 2 })
  ).toBe(1);
  expect(
    deriveProcessLimit({ cpuCount: 2, totalMemoryBytes: 64 * gib, availableMemoryBytes: 32 * gib })
  ).toBe(4);
  expect(
    deriveProcessLimit({
      cpuCount: 64,
      totalMemoryBytes: 256 * gib,
      availableMemoryBytes: 128 * gib,
    })
  ).toBe(32);
  expect(
    deriveProcessLimit({ cpuCount: 12, totalMemoryBytes: 32 * gib, availableMemoryBytes: 0 })
  ).toBe(9);
});

test("Darwin availability includes inactive and speculative pages without double-counting purgeable pages", () => {
  expect(
    reclaimableDarwinMemory(
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 2.\nPages inactive: 1000.\nPages speculative: 3.\nPages purgeable: 100.\n"
    )
  ).toBe(1005 * 16384);
  expect(reclaimableDarwinMemory("Pages free: 2.")).toBeNull();
});
