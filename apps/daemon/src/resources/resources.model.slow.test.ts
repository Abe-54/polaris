import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CommandId, type HostResourcesSnapshot } from "@polaris/protocol";
import { Exit, Fiber, Layer, ManagedRuntime } from "effect";
import fc from "fast-check";
import { EventStore } from "../store/EventStore.ts";
import { HostResources } from "./index.ts";
import { recordResourceTrace } from "./trace.testing.ts";
import { processIdentity } from "./process.ts";
import { shortTemp } from "../platform/testing.ts";

const waitForRequest = async (
  snapshot: () => Promise<HostResourcesSnapshot>,
  requestId: string
) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await snapshot();

    if (
      state.resourceLeases.some((lease) => lease.id === requestId) ||
      state.waiting.some((waiter) => waiter.requestId === requestId)
    )
      return;
    await Bun.sleep(5);
  }

  throw new Error("request was not queued or granted");
};

/** A hang guard for fixed, seeded work: 3 s alone, 9 s beside 48 busy loops, past 30 s in a loaded parallel run (`ps` per waiter). */
const MODEL_RUN_MS = 120_000;

test(
  "real FIFO broker matches an independent queue through randomized requests, releases, capacity edits and restarts",
  async () => {
    const identity = await processIdentity(process.pid);
    expect(identity).not.toBeNull();
    const originalHome = process.env.POLARIS_HOME;

    const operation = fc.record({
      kind: fc.constantFrom("take", "release", "resize", "cancel", "restart"),
      pick: fc.nat(100),
      capacity: fc.integer({ min: 1, max: 3 }),
    });

    try {
      await fc.assert(
        fc.asyncProperty(
          fc.array(operation, { minLength: 10, maxLength: 35 }),
          async (operations) => {
            const home = mkdtempSync(shortTemp("polaris-resource-model-"));
            process.env.POLARIS_HOME = home;

            const layer = HostResources.layer.pipe(
              Layer.provideMerge(EventStore.layerSqlite(join(home, "state.sqlite")))
            );

            let runtime = ManagedRuntime.make(layer);
            let resources = await runtime.runPromise(HostResources);
            const pending: ReturnType<typeof runtime.runFork>[] = [];
            let capacity = 1;
            const held: string[] = [];
            const waiting: string[] = [];

            const promote = () => {
              while (waiting.length > 0 && held.length < capacity) held.push(waiting.shift()!);
            };

            const releasePicked = async (items: string[], pick: number, commandId: CommandId) => {
              const leaseId = items[pick % items.length];

              if (leaseId === undefined) return;
              items.splice(items.indexOf(leaseId), 1);
              promote();
              await runtime.runPromise(resources.release(commandId, leaseId));
            };

            try {
              await runtime.runPromise(
                resources.declare(CommandId.make("initial"), "bench", capacity)
              );

              for (const [n, op] of operations.entries()) {
                const commandId = CommandId.make(`command-${n}`);

                switch (op.kind) {
                  case "take": {
                    const requestId = `request-${n}`;
                    waiting.push(requestId);
                    promote();
                    pending.push(
                      runtime.runFork(
                        resources.acquire({
                          requestId,
                          name: "bench",
                          processId: process.pid,
                          processIdentity: identity!,
                          command: [],
                          sessionId: null,
                        })
                      )
                    );

                    await waitForRequest(() => runtime.runPromise(resources.get), requestId);

                    break;
                  }

                  case "release": {
                    await releasePicked(held, op.pick, commandId);
                    break;
                  }

                  case "cancel": {
                    await releasePicked(waiting, op.pick, commandId);
                    break;
                  }

                  case "resize": {
                    if (op.capacity < held.length) {
                      const result = await runtime.runPromiseExit(
                        resources.declare(commandId, "bench", op.capacity)
                      );

                      expect(Exit.isFailure(result)).toBe(true);
                    } else {
                      capacity = op.capacity;
                      promote();
                      await runtime.runPromise(resources.declare(commandId, "bench", capacity));
                    }

                    break;
                  }

                  case "restart": {
                    await runtime.dispose();
                    pending.length = 0;
                    runtime = ManagedRuntime.make(layer);
                    resources = await runtime.runPromise(HostResources);
                    break;
                  }
                }

                const snapshot = await runtime.runPromise(resources.get);
                expect(snapshot.resourceLeases.map((lease) => lease.id)).toEqual(held);
                expect(snapshot.waiting.map((waiter) => waiter.requestId)).toEqual(waiting);
                expect(snapshot.resourceLeases.length).toBeLessThanOrEqual(capacity);
              }

              await runtime.runPromise(recordResourceTrace);
            } finally {
              for (const fiber of pending) await runtime.runPromise(Fiber.interrupt(fiber));
              await runtime.dispose();
              rmSync(home, { recursive: true, force: true });
            }
          }
        ),
        { numRuns: Number(process.env.POLARIS_PBT_RUNS ?? 20), seed: 0x244 }
      );
    } finally {
      if (originalHome === undefined) delete process.env.POLARIS_HOME;
      else process.env.POLARIS_HOME = originalHome;
    }
  },
  MODEL_RUN_MS
);
