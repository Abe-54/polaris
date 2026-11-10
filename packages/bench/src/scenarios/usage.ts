/**
 * usage: the Usage index over a synthetic log set (1.1 GB / 89 MB of Claude
 * transcripts and Codex rollouts). The first `usage.query` starts building
 * the index in the background (timed to `usage.watch`'s end marker); later
 * ones read only what was appended.
 */
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect, Predicate, Stream } from "effect";
import { awaitReady, cleanup, connect, createTempDir } from "../daemon.ts";
import { settle, waitUntil } from "../drive.ts";
import { type Metric, memory, peakMemory, rss, type Scenario, throughput, time } from "../types.ts";
import { usageLogs } from "../usage-logs.ts";

const ALL_TIME = {
  from: "2000-01-01T00:00:00Z",
  to: "2100-01-01T00:00:00Z",
  harness: null,
  sessionId: null,
};

const appended = (at: string, index: number) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "bench-live",
    timestamp: at,
    version: "2.1.284",
    requestId: `req_live_${index}`,
    message: {
      id: `msg_live_${index}`,
      model: "claude-opus-5-5",
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(1500) }],
      usage: {
        input_tokens: 3,
        output_tokens: 200,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 800,
      },
    },
  });

export const usage: Scenario = {
  name: "usage",
  description: "Usage index: cold build over Harness logs, no-op and incremental refresh",
  run: (ctx) =>
    Effect.gen(function* () {
      const logs = usageLogs(ctx.quick ? "quick" : "full");

      const live = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("usage-live")),
        (d) => Effect.sync(() => cleanup(d))
      );

      const liveFile = join(live, "projects", "-work-live", "bench-live.jsonl");
      mkdirSync(join(live, "projects", "-work-live"), { recursive: true });
      appendFileSync(liveFile, `${appended("2026-07-01T00:00:00Z", 0)}\n`);

      const daemon = yield* ctx.launch({
        env: { CLAUDE_CONFIG_DIR: `${logs.claude},${live}`, CODEX_HOME: logs.codex },
      });

      yield* awaitReady(daemon);
      const sampler = yield* ctx.sample(daemon, 50);
      const client = yield* connect(daemon, ctx.transport, "usage");
      const query = client.connection.client["usage.query"];
      yield* settle(1000);
      const base = sampler.sample();

      const tokens = (report: {
        readonly buckets: ReadonlyArray<{ tokens: { output: number } }>;
      }) => report.buckets.reduce((sum, b) => sum + b.tokens.output, 0);

      // The first query answers at once (marked `indexing`); the build ends with the watch's marker.
      let buildEnd = 0;

      yield* Effect.forkScoped(
        client.connection.client["usage.watch"]({}).pipe(
          Stream.filter((item) => Predicate.isTagged(item, "UsageChanged") && !item.indexing),
          Stream.take(1),
          Stream.runForEach(() => Effect.sync(() => (buildEnd = performance.now())))
        )
      );

      const t0 = performance.now();
      yield* query(ALL_TIME);
      yield* waitUntil(() => buildEnd > 0, 600_000, "the first index pass");
      const buildMs = buildEnd - t0;
      const buildReport = sampler.report(base.t - 1, sampler.sample().t);
      const built = yield* query(ALL_TIME);

      const t1 = performance.now();
      yield* query(ALL_TIME);
      const noopMs = performance.now() - t1;

      for (let i = 1; i <= 100; i++)
        appendFileSync(liveFile, `${appended("2026-07-01T01:00:00Z", i)}\n`);

      // Until a query shows every appended response.
      const t2 = performance.now();
      let after = yield* query(ALL_TIME);

      while (tokens(after) - tokens(built) < 100 * 200 && performance.now() - t2 < 30_000)
        after = yield* query(ALL_TIME);

      const appendMs = performance.now() - t2;
      yield* settle(2000);
      const settled = sampler.sample();
      yield* ctx.peak(daemon, "after-build");

      const indexBytes = statSync(join(daemon.home, "usage.sqlite")).size;

      if (tokens(after) - tokens(built) !== 100 * 200)
        return yield* Effect.die(new Error("the appended responses were not all indexed"));

      const metrics: Record<string, Metric> = {};

      Object.assign(metrics, {
        build_ms: time(buildMs, { tolerance: { relative: 0.25, absolute: 200 } }),
        build_mb_per_s: throughput(logs.bytes / 1e6 / (buildMs / 1000), "MB/s", {
          tolerance: { relative: 0.25, absolute: 0 },
        }),
        build_rss_peak_over_base_mib: rss(peakMemory(buildReport.rssBytes.max - base.rssBytes)),
        noop_refresh_ms: time(noopMs, { tolerance: { relative: 0.5, absolute: 20 } }),
        append_refresh_ms: time(appendMs, { tolerance: { relative: 0.5, absolute: 20 } }),
        rss_settled_mib: rss(peakMemory(settled.rssBytes)),
        index_mib: memory(indexBytes, { tolerance: { relative: 0.1, absolute: 1 } }),
      } satisfies Record<string, Metric>);

      if (buildReport.footprintBytes && base.footprintBytes !== null)
        metrics.build_footprint_peak_over_base_mib = peakMemory(
          buildReport.footprintBytes.max - base.footprintBytes
        );

      if (settled.footprintBytes !== null)
        metrics.footprint_settled_mib = peakMemory(settled.footprintBytes);

      return {
        metrics,
        notes: [
          `${(logs.bytes / 1e6).toFixed(0)} MB of logs, ${built.buckets.length} hourly buckets; RSS sampled every 50 ms`,
        ],
      };
    }),
};
