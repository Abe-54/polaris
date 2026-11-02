import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { DeveloperModeControl, fromSourceFor } from "./live.ts";
import { DeveloperModeState } from "./service.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

let home = "";

const previous = process.env.POLARIS_HOME;

beforeAll(() => {
  home = newTempDir("pl-dms-", { short: true });
  process.env.POLARIS_HOME = home;
});

afterAll(() => {
  if (previous === undefined) delete process.env.POLARIS_HOME;
  else process.env.POLARIS_HOME = previous;
  removeTempDir(home);
});

test.each([
  ["off", false, false],
  ["off", true, false],
  ["on", true, true],
  ["on", false, true],
  [undefined, false, true],
  [undefined, true, false],
  ["yes", false, true],
] as const)(
  "POLARIS_DEVELOPER_MODE=%s with a compiled binary %s is from source: %s",
  (override, embedded, fromSource) => {
    expect(fromSourceFor(override, embedded)).toBe(fromSource);
  }
);

// The tracers read `DeveloperModeState` from these services; a fixed-off stand-in would never trace.
test("the served Daemon's Developer Mode is the live one, and follows the stored setting", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { engineServices } = yield* Effect.promise(() => import("../transport/serve.ts"));
        const services = yield* Layer.build(engineServices);
        const state = Effect.provide(Effect.service(DeveloperModeState), services);
        const control = yield* Effect.provide(Effect.service(DeveloperModeControl), services);

        // The test preload sets POLARIS_DEVELOPER_MODE=off, so from source alone is off.
        expect(yield* Effect.flatMap(state, (s) => s.current)).toMatchObject({
          fromSource: false,
          effective: false,
        });

        yield* control.setStored(true);

        expect((yield* Effect.flatMap(state, (s) => s.current)).effective).toBe(true);
      })
    )
  ));

// Data reads `DeveloperModeState` optionally; without it in the served graph no Daemon Source shows.
test("the served Daemon lists its own databases as Daemon Sources once Developer Mode is on", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { engineServices } = yield* Effect.promise(() => import("../transport/serve.ts"));
        const { DataSources } = yield* Effect.promise(() => import("../data/services.ts"));

        const { seedDataSessionAt, started } = yield* Effect.promise(
          () => import("../data/approvals.testing.ts")
        );

        const services = yield* Layer.build(engineServices);
        const control = yield* Effect.provide(Effect.service(DeveloperModeControl), services);
        const sources = yield* Effect.provide(Effect.service(DataSources), services);
        yield* Effect.provide(seedDataSessionAt(home), services);
        const sessionId = started.session.id;

        const daemon = Effect.map(sources.list({ sessionId }), (list) =>
          list.filter((source) => source.foundIn.kind === "daemon").map((source) => source.name)
        );

        // The test before this one stored the setting on in this home.
        yield* control.setStored(false);

        expect(yield* daemon).toEqual([]);

        yield* control.setStored(true);

        expect(yield* daemon).toContain("Daemon · state");
      })
    )
  ));
