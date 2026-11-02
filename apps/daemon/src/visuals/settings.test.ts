import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { VisualsSettings } from "@polaris/protocol";
import { Effect } from "effect";
import { visualsFile } from "./settings.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const withPath = async (body: (path: string) => Promise<void>) => {
  const root = newTempDir("polaris-visuals-", { short: true });

  try {
    await body(join(root, "nested", "visuals-settings.json"));
  } finally {
    removeTempDir(root);
  }
};

test("a saved level reaches every reader of the file, so a session opened later follows it", () =>
  withPath(async (path) => {
    await Effect.runPromise(visualsFile(path).setSettings(VisualsSettings.make({ level: "off" })));

    expect((await Effect.runPromise(visualsFile(path).settings)).level).toBe("off");
  }));

test("a missing or unreadable file is rich", () =>
  withPath(async (path) => {
    expect((await Effect.runPromise(visualsFile(path).settings)).level).toBe("rich");

    await Effect.runPromise(
      visualsFile(path).setSettings(VisualsSettings.make({ level: "simple" }))
    );
    writeFileSync(path, '{"level":"loud"}');
    expect((await Effect.runPromise(visualsFile(path).settings)).level).toBe("rich");
  }));
