import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Effect, Layer } from "effect";
import { shortTemp } from "../platform/testing.ts";
import { DeveloperModeControl, fromSourceFor } from "./live.ts";
import { DeveloperModeState } from "./service.ts";

let home = "";

const previous = process.env.POLARIS_HOME;

beforeAll(() => {
  home = mkdtempSync(shortTemp("pl-dms-"));
  process.env.POLARIS_HOME = home;
});

afterAll(() => {
  if (previous === undefined) delete process.env.POLARIS_HOME;
  else process.env.POLARIS_HOME = previous;
  rmSync(home, { recursive: true, force: true });
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
