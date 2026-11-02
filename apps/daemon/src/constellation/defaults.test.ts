import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConstellationSettings } from "@polaris/protocol";
import { Effect } from "effect";
import { ConstellationDefaultsPath, getDefaults, setDefaults } from "./defaults.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

test("Host defaults round-trip atomically and tolerate missing or invalid settings", async () => {
  const dir = newTempDir("c1-defaults-");
  const path = join(dir, "settings.json");

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        expect((yield* getDefaults).branchPrefix).toBeUndefined();
        const settings = ConstellationSettings.make({ branchPrefix: "team", transfer: "bundle" });
        yield* setDefaults(settings);
        expect(yield* getDefaults).toEqual(settings);
        writeFileSync(path, "broken");
        expect((yield* getDefaults).branchPrefix).toBeUndefined();
      }).pipe(Effect.provideService(ConstellationDefaultsPath, path))
    );
  } finally {
    removeTempDir(dir);
  }
});
