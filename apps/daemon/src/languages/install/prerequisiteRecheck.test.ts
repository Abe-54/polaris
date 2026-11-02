import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { LanguageHostState } from "@polaris/protocol";
import { Tool } from "../catalog/model.ts";
import { createHostPrerequisiteProbe } from "./hostStateProbes.ts";
import { createHostToolStates } from "./hostState.ts";
import { artifactFixture, hostId, platform } from "./fixture.testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

for (const [id, executable] of [
  ["shellcheck", "shellcheck"],
  ["python-interpreter", "python3"],
  ["uv", "uv"],
  ["go", "go"],
  ["gopls", "gopls"],
  ["php", "php"],
] as const)
  test(`explicit recheck replaces cached ${id} absence and republishes to the existing watch`, async () => {
    const home = newTempDir("prerequisite-recheck-", { short: true });
    const directory = join(home, "bin");
    await mkdir(directory);

    const lifetime = new AbortController();

    const tool = Schema.decodeUnknownSync(Tool)({
      ...artifactFixture().tool,
      requirements: [
        {
          id,
          executable,
          scope: "companion",
          version: "present",
          required: true,
          detail: "Host tool",
        },
      ],
    });

    const states = createHostToolStates({
      hostId,
      platform,
      tools: [tool],
      lifetime: lifetime.signal,
      probes: createHostPrerequisiteProbe({ home, directories: [directory] }),
      installer: {
        current: async () => null,
        progress: () => null,
        recoveryFacts: async () => [],
        subscribe: () => () => {},
      },
    });

    const input = { toolIds: [tool.id], refresh: false };

    try {
      const watch = await states.watch(input, lifetime.signal);
      const initial = Schema.decodeUnknownSync(LanguageHostState)((await watch.next()).value);

      expect(initial.tools[0]?.prerequisites[0]?.presence).toBe("missing");

      const path = join(directory, executable);
      await writeFile(path, "#!/bin/sh\necho SHOULD_NOT_EXECUTE > marker\n", { mode: 0o755 });
      expect((await states.read(input, lifetime.signal)).tools[0]?.prerequisites[0]?.presence).toBe(
        "missing"
      );
      await watch.next();
      const refreshed = await states.read({ ...input, refresh: true }, lifetime.signal);
      expect(refreshed.tools[0]?.prerequisites[0]).toMatchObject({ presence: "present", path });
      const published = Schema.decodeUnknownSync(LanguageHostState)((await watch.next()).value);
      expect(published).toEqual(refreshed);
      expect(await Bun.file(join(home, "marker")).exists()).toBe(false);
      await rm(path);
      expect(
        (await states.read({ ...input, refresh: true }, lifetime.signal)).tools[0]?.prerequisites[0]
          ?.presence
      ).toBe("missing");
      await watch.return?.();
      expect(states.stats().subscribers).toBe(0);
    } finally {
      lifetime.abort();
      await removeTempDirSettled(home);
    }
  });
