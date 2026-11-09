/**
 * files: path search and grep on a large generated repo (full: 50k files),
 * with fff and with the git fallback (`POLARIS_FFF=off`), each in its own
 * Daemon, plus the memory the fff index costs.
 */
import { Effect } from "effect";
import { awaitReady, type Client, connect } from "../daemon.ts";
import { settle } from "../drive.ts";
import { sourceTree } from "../fixtures.ts";
import { summarize } from "../stats.ts";
import { latency, type Metric, peakMemory, rss, type Scenario, time } from "../types.ts";

const PATH_QUERIES = [
  "sessionTurn",
  "workspace",
  "pkg0/mod7",
  "engineStore12",
  "deltaSnap",
  "harness",
];

const GREP_QUERIES: ReadonlyArray<{ pattern: string; regex: boolean }> = [
  { pattern: "needleBench", regex: false },
  { pattern: "checkpoint", regex: false },
  { pattern: "export const needle\\w+ = true", regex: true },
];

const REPEAT = 5;

const measure = (client: Client, root: string) =>
  Effect.gen(function* () {
    const rpc = client.connection.client;
    // The first search builds the index (lazily, per root).
    const t0 = performance.now();
    const first = yield* rpc["files.searchPaths"]({ root, query: "sessionTurn", limit: 50 });
    const firstMs = performance.now() - t0;
    // Let a background scan finish before timing steady-state queries.
    yield* settle(3000);
    const search: Array<number> = [];
    const grep: Array<number> = [];
    let grepHits = 0;

    for (let r = 0; r < REPEAT; r++) {
      for (const query of PATH_QUERIES) {
        const t = performance.now();
        yield* rpc["files.searchPaths"]({ root, query, limit: 50 });
        search.push(performance.now() - t);
      }

      for (const q of GREP_QUERIES) {
        const t = performance.now();

        const hits = yield* rpc["files.grep"]({
          root,
          pattern: q.pattern,
          regex: q.regex,
          caseSensitive: true,
          limit: 200,
        });

        grep.push(performance.now() - t);

        if (r === 0) grepHits += hits.length;
      }
    }

    return {
      firstMs,
      firstHits: first.length,
      search: summarize(search),
      grep: summarize(grep),
      grepHits,
    };
  });

export const files: Scenario = {
  name: "files",
  description: "fff vs git-fallback path search and grep latency on a large repo; index memory",
  run: (ctx) =>
    Effect.gen(function* () {
      const count = ctx.quick ? 5_000 : 50_000;
      ctx.log(`files: preparing a ${count}-file repo (cached after the first run)…`);
      const root = sourceTree(count);
      const metrics: Record<string, Metric> = {};
      const notes: Array<string> = [];

      for (const backend of ["fff", "fallback"] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const daemon = yield* ctx.launch(
              backend === "fallback" ? { env: { POLARIS_FFF: "off" } } : {}
            );

            yield* awaitReady(daemon);
            const sampler = yield* ctx.sample(daemon, 250);
            const client = yield* connect(daemon, ctx.transport, "files");
            yield* settle(1000);
            const before = sampler.sample();
            const result = yield* measure(client, root);
            yield* settle(1000);
            const after = sampler.sample();

            if (backend === "fff") yield* ctx.peak(daemon, "fff-index");
            const b = backend;
            metrics[`${b}.first_search_ms`] = time(result.firstMs);
            metrics[`${b}.search_p50_ms`] = latency(result.search.median);
            metrics[`${b}.search_p95_ms`] = latency(result.search.p95);
            metrics[`${b}.grep_p50_ms`] = latency(result.grep.median);
            metrics[`${b}.grep_p95_ms`] = latency(result.grep.p95);
            metrics[`${b}.index_rss_mib`] = rss(peakMemory(after.rssBytes - before.rssBytes));

            if (after.footprintBytes !== null && before.footprintBytes !== null) {
              metrics[`${b}.index_footprint_mib`] = peakMemory(
                after.footprintBytes - before.footprintBytes
              );
            }

            metrics[`${b}.rss_mib`] = rss(peakMemory(after.rssBytes));

            if (after.footprintBytes !== null)
              metrics[`${b}.footprint_mib`] = peakMemory(after.footprintBytes);

            notes.push(
              `${b}: first search returned ${result.firstHits} paths; grep hits ${result.grepHits} (limit 200 per query)`
            );
          })
        );
      }

      notes.push(
        `${count} files (~1.5 KB each) committed to git; ${PATH_QUERIES.length} path queries and ${GREP_QUERIES.length} greps × ${REPEAT}`
      );

      return { metrics, notes };
    }),
};
