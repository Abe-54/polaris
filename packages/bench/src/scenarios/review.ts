/**
 * review: Review on Pierre Diffs under load (ENG-218, ENG-230), on the built Desktop App
 * against a real Daemon. Runs `apps/desktop/scripts/reviewBench.ts` (Node, Playwright's
 * Electron launcher) and reads its JSON: each scene's parse time, scroll frames against
 * the display's interval, the app's memory and the Daemon's peak RSS while it diffs.
 * Build the app first: `bun run --cwd apps/desktop build`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { createTempDir, REPO_ROOT } from "../daemon.ts";
import { count, latency, type Metric, memory, rss, type Scenario, time } from "../types.ts";

const APP_DIR = join(REPO_ROOT, "apps", "desktop");

const MiB = 1024 * 1024;

const SceneResult = Schema.Struct({
  files: Schema.Number,
  patchMiB: Schema.Number,
  firstFileMs: Schema.Number,
  completeMs: Schema.Number,
  frameP50Ms: Schema.Number,
  frameP95Ms: Schema.Number,
  frameP99Ms: Schema.Number,
  frameMaxMs: Schema.Number,
  droppedShare: Schema.Number,
  appMiB: Schema.Number,
  appScrolledMiB: Schema.Number,
  daemonPeakRssMiB: Schema.Number,
  ok: Schema.Boolean,
});

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ scenes: Schema.Record(Schema.String, SceneResult) }))
);

const MEMORY_TOLERANCE = { relative: 0.15, absolute: 40 } as const;

const sceneMetrics = (name: string, scene: typeof SceneResult.Type) =>
  ({
    [`${name}_first_file_ms`]: time(scene.firstFileMs),
    [`${name}_parsed_ms`]: time(scene.completeMs),
    [`${name}_frame_p95_ms`]: latency(scene.frameP95Ms, {
      tolerance: { relative: 0.2, absolute: 1 },
    }),
    [`${name}_frame_p99_ms`]: latency(scene.frameP99Ms, { info: true }),
    [`${name}_dropped_pct`]: count(scene.droppedShare * 100, "%", { info: true }),
    [`${name}_app_mib`]: memory(scene.appMiB * MiB, { tolerance: MEMORY_TOLERANCE }),
    [`${name}_app_scrolled_mib`]: memory(scene.appScrolledMiB * MiB, { info: true }),
    [`${name}_daemon_peak_rss_mib`]: rss(
      memory(scene.daemonPeakRssMiB * MiB, { tolerance: MEMORY_TOLERANCE })
    ),
  }) satisfies Record<string, Metric>;

export const review: Scenario = {
  name: "review",
  description:
    "Review on Pierre Diffs: 2k/5k/12k files and a 100k-line file, parse, frames, memory",
  run: (ctx) =>
    Effect.sync(() => {
      if (process.platform !== "darwin" || !existsSync(join(APP_DIR, "out", "main", "index.js"))) {
        return {
          metrics: {},
          notes: [
            "skipped: macOS only, and build the app first (bun run --cwd apps/desktop build)",
          ],
        };
      }

      const json = join(createTempDir("review"), "review.json");

      const run = spawnSync(
        "node",
        [
          join(APP_DIR, "scripts", "reviewBench.ts"),
          "--json",
          json,
          ...(ctx.quick ? ["--quick"] : []),
        ],
        { cwd: APP_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30 * 60_000 }
      );

      const lines = `${run.stdout}${run.stderr}`
        .split("\n")
        .filter((l) => l.startsWith("review-bench"));

      if (!existsSync(json))
        throw new Error(`reviewBench wrote no result:\n${run.stderr.slice(-2000)}`);

      const { scenes } = decodeResult(readFileSync(json, "utf8"));

      const metrics = Object.fromEntries(
        Object.entries(scenes).flatMap(([name, scene]) =>
          Object.entries(sceneMetrics(name.replace("-", "_"), scene))
        )
      );

      return {
        metrics,
        notes: [
          "budgets: frame p95 ≤ 1.5 display intervals, ≤ 2% dropped, the app < 1 GB with the Review open",
          "app_scrolled_mib: after 600 frames at 240 px, a GC forced (Pierre keeps pages it touched)",
          ...lines,
        ],
      };
    }),
};
