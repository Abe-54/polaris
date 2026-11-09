import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { makeBenchDriver } from "./bench/BenchDriver.ts";
import { isBenchKind } from "./bench/kinds.ts";
import { makeClaudeDriver } from "./claude/ClaudeDriver.ts";
import { makeCodexDriver } from "./codex/CodexDriver.ts";
import type { HarnessDriver } from "./HarnessDriver.ts";
import { makeOpenCodeDriver } from "./opencode/OpenCodeDriver.ts";
import { HarnessRegistry } from "../services.ts";
import { PlanLimitReporter } from "./limits/PlanLimitReporter.ts";
import { BrowserMcp } from "./browser/index.ts";
import { DRIVER_CAPABILITIES, harnessRegistryLayer, lazyDriver } from "./registry.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

describe("lazyDriver", () => {
  test("loads the real driver once, on first probe, not when built", async () => {
    let loads = 0;

    const real: HarnessDriver = {
      kind: "codex",
      capabilities: DRIVER_CAPABILITIES.codex,
      probe: Effect.succeed({ available: true, version: "1.2.3", detail: null }),
      open: () => Effect.die("unused"),
    };

    const driver = await Effect.runPromise(
      lazyDriver(
        "codex",
        DRIVER_CAPABILITIES.codex,
        Effect.sync(() => {
          loads++;

          return real;
        })
      )
    );

    expect(loads).toBe(0);
    expect(driver.capabilities).toEqual(real.capabilities);
    expect((await Effect.runPromise(driver.probe)).version).toBe("1.2.3");
    await Effect.runPromise(driver.probe);
    expect(loads).toBe(1);
  });

  test("declared capabilities match the drivers they stand in for", async () => {
    const dir = newTempDir("polaris-registry-");

    try {
      const codex = await Effect.runPromise(
        Effect.scoped(
          makeCodexDriver({
            codexPath: null,
            socketPath: join(dir, "codex.sock"),
            spawnAppServer: false,
          })
        )
      );

      expect(codex.capabilities).toEqual(DRIVER_CAPABILITIES.codex);

      const opencode = await Effect.runPromise(
        Effect.scoped(makeOpenCodeDriver({ opencodePath: () => null, stateDir: dir }))
      );

      expect(opencode.capabilities).toEqual(DRIVER_CAPABILITIES.opencode);
      expect(makeClaudeDriver().capabilities).toEqual(DRIVER_CAPABILITIES.claude);
      expect(makeBenchDriver("claude").capabilities).toEqual(DRIVER_CAPABILITIES.bench);
      expect(makeBenchDriver("codex").capabilities).toEqual(DRIVER_CAPABILITIES.bench);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("bench mode", () => {
  test("the bench stands in for Claude Code and Codex only; the other drivers are real", async () => {
    // Point the real Harnesses at binaries that don't exist, so nothing real starts.
    const missing = {
      POLARIS_OPENCODE: "/nonexistent/opencode",
      POLARIS_GEMINI: "/nonexistent/gemini",
      POLARIS_COPILOT: "/nonexistent/copilot",
    };

    const saved = Object.fromEntries(Object.keys(missing).map((k) => [k, process.env[k]]));
    Object.assign(process.env, missing);

    try {
      const report = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* HarnessRegistry;
            const drivers = yield* registry.all;

            return yield* Effect.forEach(drivers, (driver) =>
              Effect.gen(function* () {
                const probe = yield* driver.probe;

                // Only the bench kinds are asked for Models: a real driver would start its Harness.
                const models = isBenchKind(driver.kind)
                  ? yield* driver.listModels ?? Effect.succeed([])
                  : [];

                return {
                  kind: driver.kind,
                  version: probe.version,
                  available: probe.available,
                  models: models.map((m) => m.id),
                };
              })
            );
          })
        ).pipe(
          Effect.provide(
            harnessRegistryLayer({ bench: true }).pipe(
              Layer.provide(Layer.mergeAll(PlanLimitReporter.none, BrowserMcp.none))
            )
          )
        )
      );

      const byKind = Object.fromEntries(report.map((r) => [r.kind, r]));

      for (const kind of ["claude", "codex"])
        expect(byKind[kind]).toMatchObject({
          version: "bench",
          available: true,
          models: ["bench-large", "bench-small"],
        });

      for (const kind of ["opencode", "gemini", "copilot"])
        expect(byKind[kind]).toMatchObject({ available: false });
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
});

describe("binaries found at each use (ENG-413)", () => {
  test("a Codex installed on PATH after the registry is built is available without a restart", async () => {
    const dir = newTempDir("polaris-registry-");
    const bin = join(dir, "bin");

    const vars = {
      PATH: bin,
      POLARIS_HOME: dir,
      POLARIS_CODEX: undefined,
      POLARIS_CLAUDE: undefined,
    };

    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));

    const restoreEnv = (values: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(values))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    };

    restoreEnv(vars);

    try {
      const [before, after, claude] = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* HarnessRegistry;
            const codex = yield* registry.get("codex");

            const missing = yield* codex.probe;
            const claude = yield* (yield* registry.get("claude")).probe;

            yield* Effect.sync(() => {
              mkdirSync(bin);
              writeFileSync(join(bin, "codex"), "#!/bin/sh\necho codex-cli 0.98.0\n");
              chmodSync(join(bin, "codex"), 0o755);
            });

            return [missing, yield* codex.probe, claude] as const;
          })
        ).pipe(
          Effect.provide(
            harnessRegistryLayer({ bench: false }).pipe(
              Layer.provide(Layer.mergeAll(PlanLimitReporter.none, BrowserMcp.none))
            )
          )
        )
      );

      expect(before).toEqual({
        available: false,
        version: null,
        detail: `codex was not found on the Daemon's PATH (${bin})`,
      });
      expect(after).toEqual({ available: true, version: "0.98.0", detail: join(bin, "codex") });
      expect(claude.detail).toBe(`\`claude\` was not found on the Daemon's PATH (${bin})`);
    } finally {
      restoreEnv(saved);
      removeTempDir(dir);
    }
  });
});
