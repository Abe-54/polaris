import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { DomainEvent } from "@polaris/protocol";
import { EventStore } from "../../store/EventStore.ts";
import { withProfiles } from "../profiles/testing.ts";
import { TEST_SESSION } from "../testing.ts";
import { InspectorTargets } from "./registry.ts";

// Use the production Layer's event subscription, not a test's direct prune call.
test.each([false, true])(
  "P9-3: archive retires launch capabilities even when immediately unarchived: %p",
  (unarchive) =>
    withProfiles(async ({ root, runtime }) => {
      const store = await runtime.runPromise(EventStore);

      const layer = InspectorTargets.layerAt(join(root, "lifecycle-bootstrap")).pipe(
        Layer.provide(Layer.succeed(EventStore, store))
      );

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const targets = yield* InspectorTargets;
            const script = join(root, "lifecycle.cjs");
            yield* Effect.promise(() => writeFile(script, "setInterval(() => {}, 1000);"));
            const environment = yield* Effect.promise(() => targets.environment(TEST_SESSION));

            const child = Bun.spawn([Bun.which("node")!, script], {
              env: { ...process.env, ...environment },
              stdout: "ignore",
              stderr: "ignore",
            });

            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                child.kill();
                await child.exited;
              })
            );

            const registered = () => {
              try {
                return targets.get(TEST_SESSION, child.pid);
              } catch {
                return null;
              }
            };

            for (let n = 0; n < 250 && registered() === null; n++) yield* Effect.sleep(20);
            expect(registered()?.pid).toBe(child.pid);
            yield* store.commit({
              commandId: null,
              decide: () =>
                Effect.succeed([
                  DomainEvent.cases.SessionStateChanged.make({
                    sessionId: TEST_SESSION,
                    state: "archived",
                    reason: null,
                  }),
                  ...(unarchive
                    ? [
                        DomainEvent.cases.SessionStateChanged.make({
                          sessionId: TEST_SESSION,
                          state: "dormant",
                          reason: null,
                        }),
                      ]
                    : []),
                ]),
            });

            for (let n = 0; n < 250 && registered() !== null; n++) yield* Effect.sleep(20);
            expect(registered()).toBeNull();

            const sibling = Bun.spawn([Bun.which("node")!, script], {
              env: { ...process.env, ...environment },
              stdout: "ignore",
              stderr: "ignore",
            });

            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                sibling.kill();
                await sibling.exited;
              })
            );
            yield* Effect.sleep(250);
            expect(() => targets.get(TEST_SESSION, sibling.pid)).toThrow("not registered");
          })
        ).pipe(Effect.provide(layer))
      );
    }),
  15000
);
