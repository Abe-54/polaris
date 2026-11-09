/**
 * rules: the Rules layer (Betterleaks + ast-grep, apps/daemon/src/rules/) on
 * a large change: 1,000 / 200 files of a generated tree rewritten with 40
 * added lines each, some risky. Each mode runs in its own process
 * (`apps/daemon/scripts/rules-run.ts`), sampled as a tree, so the Betterleaks
 * and `polaris rules-scan` children count. No Daemon: nothing runs the Rules
 * over RPC yet, and the Rules add nothing to an idle Daemon (no timers, no
 * processes until a Review asks).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { cleanup, createTempDir } from "../daemon.ts";
import { copyTree, git, sourceTree } from "../fixtures.ts";
import { startSampler } from "../sampler.ts";
import { count, cpu, type Metric, peakMemory, rss, type Scenario, time } from "../types.ts";

const root = join(import.meta.dir, "..", "..", "..", "..");

const runner = join(root, "apps", "daemon", "scripts", "rules-run.ts");

const decodeReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ ms: Schema.Number, findings: Schema.Int, notes: Schema.Array(Schema.String) })
  )
);

/** 40 lines per file; every 50th file gets a risky line the pack flags. */
const addedLines = (i: number) => {
  const lines = Array.from(
    { length: 40 },
    (_, l) => `export const added${i}_${l} = (value: string) => value.trim() + "${l}";`
  );

  if (i % 50 === 0) lines.push("eval(process.argv[2]);");

  return `${lines.join("\n")}\n`;
};

const lsFiles = (repo: string) => git(repo, "ls-files", "packages").trim().split("\n");

/** Rewrite `files` files with added lines; returns base and head commits. */
const makeChange = (repo: string, files: number) => {
  const base = git(repo, "rev-parse", "HEAD").trim();
  const paths = lsFiles(repo).slice(0, files);

  for (const [i, path] of paths.entries()) {
    const full = join(repo, path);
    writeFileSync(full, readFileSync(full, "utf8") + addedLines(i));
  }

  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "large change");

  return { base, head: git(repo, "rev-parse", "HEAD").trim() };
};

const runOnce = (repo: string, base: string, head: string, mode: string) =>
  Effect.promise(async () => {
    const proc = Bun.spawn([process.execPath, runner, repo, base, head, mode], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const sampler = startSampler({ roots: () => [proc.pid], intervalMs: 20 });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const tree = sampler.report();
    sampler.stop();

    if (code !== 0) throw new Error(`rules-run ${mode} exited ${code}: ${stderr}`);
    const report = decodeReport(stdout.trim().split("\n").at(-1) ?? "");

    return { report, tree };
  });

export const rules: Scenario = {
  name: "rules",
  description: "Rules layer (secrets + patterns) on a large change, as a process tree",
  run: (ctx) =>
    Effect.gen(function* () {
      const treeSize = 5_000;
      const changed = ctx.quick ? 200 : 1_000;
      ctx.log(`rules: preparing a ${changed}-file change (tree cached after the first run)…`);

      const dir = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("rules")),
        (d) => Effect.sync(() => cleanup(d))
      );

      const repo = copyTree(sourceTree(treeSize), join(dir, "repo"));
      const { base, head } = makeChange(repo, changed);
      const metrics: Record<string, Metric> = {};
      const notes = [`${changed} files changed, ${changed * 40} added lines`];

      for (const mode of ["history", "snapshot"] as const) {
        const { report, tree } = yield* runOnce(repo, base, head, mode);
        Object.assign(metrics, {
          [`${mode}_ms`]: time(report.ms),
          [`${mode}_peak_rss_mib`]: rss(peakMemory(tree.rssBytes.max)),
          [`${mode}_cpu_avg_pct`]: cpu(tree.cpuAvgPct),
          [`${mode}_findings`]: count(report.findings, "findings", { better: "higher" }),
        });

        if (tree.footprintBytes)
          metrics[`${mode}_peak_footprint_mib`] = peakMemory(tree.footprintBytes.max);

        for (const note of report.notes) notes.push(`${mode}: ${note}`);
        const top = [...tree.processes].sort((a, b) => b.maxRssBytes - a.maxRssBytes).slice(0, 3);
        notes.push(
          `${mode} peaks: ${top.map((p) => `${p.name} ${(p.maxRssBytes / 2 ** 20).toFixed(0)} MiB`).join(", ")}`
        );
      }

      return { metrics, notes };
    }),
};
