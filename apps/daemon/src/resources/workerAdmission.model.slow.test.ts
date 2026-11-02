import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { CommandId, SessionId } from "@polaris/protocol";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Scope } from "effect";
import fc from "fast-check";
import { EventStore } from "../store/EventStore.ts";
import { HostResources } from "./index.ts";
import { registerWorkerAdmission } from "./workerAdmission.ts";
import { shortTemp } from "../platform/testing.ts";

const eventually = async (ready: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await ready()) return;
    await Bun.sleep(2);
  }

  throw new Error("admission did not match the model");
};

test("blocked admission matches an independent FIFO through randomized waits, wakes and stops", async () => {
  const previous = process.env.POLARIS_HOME;

  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom("start", "block", "wake", "stop"),
            pick: fc.integer({ min: 0, max: 2 }),
          }),
          { minLength: 15, maxLength: 40 }
        ),
        async (ops) => {
          const root = mkdtempSync(shortTemp("worker-admission-model-"));
          process.env.POLARIS_HOME = root;

          const runtime = ManagedRuntime.make(
            HostResources.layer.pipe(Layer.provideMerge(EventStore.layerSqlite(":memory:")))
          );

          const scopes = new Map<number, Scope.Closeable>();

          const controllers = new Map<
            number,
            Effect.Success<
              ReturnType<typeof registerWorkerAdmission<import("@polaris/protocol").ResourceError>>
            >
          >();

          const fibers = new Map<
            number,
            Fiber.Fiber<
              boolean,
              import("@polaris/protocol").ResourceError | import("../services.ts").ServiceError
            >
          >();

          const blocked = new Set<number>();
          const held: number[] = [];
          const queue: number[] = [];

          const promote = () => {
            if (held.length === 0 && queue.length > 0) held.push(queue.shift()!);
          };

          const remove = (items: number[], pick: number) => {
            const index = items.indexOf(pick);

            if (index !== -1) items.splice(index, 1);
          };

          try {
            const store = await runtime.runPromise(EventStore);
            const resources = await runtime.runPromise(HostResources);
            await runtime.runPromise(resources.setWorkerCap(CommandId.make("cap"), 1));

            const operate = async ({ kind, pick }: (typeof ops)[number]) => {
              if (kind === "stop") {
                const scope = scopes.get(pick);

                if (scope !== undefined) await runtime.runPromise(Scope.close(scope, Exit.void));
                scopes.delete(pick);
                controllers.delete(pick);
                blocked.delete(pick);
                remove(held, pick);
                remove(queue, pick);
                promote();
              } else if (kind === "block") {
                const controller = controllers.get(pick);

                if (controller !== undefined) {
                  blocked.add(pick);
                  await runtime.runPromise(controller.suspend);
                  remove(held, pick);
                  remove(queue, pick);
                  promote();
                }
              } else {
                let controller = controllers.get(pick);

                if (controller === undefined) {
                  const scope = await runtime.runPromise(Scope.make());
                  scopes.set(pick, scope);
                  controller = await runtime.runPromise(
                    registerWorkerAdmission(
                      store,
                      SessionId.make(`worker-${pick}`),
                      scope,
                      resources.acquireWorker(SessionId.make(`worker-${pick}`)),
                      Effect.sync(() => blocked.has(pick))
                    )
                  );
                  controllers.set(pick, controller);
                }

                if (!held.includes(pick) && !queue.includes(pick)) {
                  blocked.delete(pick);
                  queue.push(pick);
                  promote();
                  fibers.set(pick, runtime.runFork(controller.ensure));
                }
              }
            };

            for (const op of ops) {
              await operate(op);
              await eventually(async () => {
                const model = await runtime.runPromise(store.model);

                const leases = [...(model.hostResources?.leases.values() ?? [])].map(
                  (l) => l.sessionId
                );

                const waiting = [...(model.hostResources?.waiting.values() ?? [])].map(
                  (w) => w.sessionId
                );

                return (
                  JSON.stringify(leases) === JSON.stringify(held.map((n) => `worker-${n}`)) &&
                  JSON.stringify(waiting) === JSON.stringify(queue.map((n) => `worker-${n}`))
                );
              });
              const snapshot = await runtime.runPromise(resources.get);
              expect(snapshot.workerCap.working).toBe(held.length);
              expect(snapshot.workerCap.waiting).toBe(queue.length);
              expect(snapshot.workerCap.working).toBeLessThanOrEqual(1);
            }
          } finally {
            for (const scope of scopes.values())
              await runtime.runPromise(Scope.close(scope, Exit.void));

            for (const fiber of fibers.values()) await runtime.runPromise(Fiber.interrupt(fiber));
            await runtime.dispose();
            rmSync(root, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 30, seed: 61742 }
    );
  } finally {
    if (previous === undefined) delete process.env.POLARIS_HOME;
    else process.env.POLARIS_HOME = previous;
  }
});
