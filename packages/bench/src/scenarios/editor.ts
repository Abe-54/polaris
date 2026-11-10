import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readEditorFile, writeEditorFile } from "@polaris/client";
import { Effect, Stream } from "effect";
import { awaitReady, cleanup, connect, createTempDir } from "../daemon.ts";
import { settle, waitUntil } from "../drive.ts";
import { cpu, latency, memory, type Metric, rss, type Scenario, throughput } from "../types.ts";

export const editor: Scenario = {
  name: "editor",
  description: "1 MiB versioned open/save on socket and fake remote bridge; 20 idle tab watches",
  run: (ctx) =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("editor")),
        (dir) => Effect.sync(() => cleanup(dir))
      );

      const text = "const greeting = 'hello';\r\n".repeat(40330).slice(0, 1024 * 1024);
      const paths = Array.from({ length: 20 }, (_, index) => join(root, `tab-${index}.ts`));
      yield* Effect.promise(() => Promise.all(paths.map((path) => writeFile(path, text))));
      const daemon = yield* ctx.launch();
      yield* awaitReady(daemon);
      const sampler = yield* ctx.sample(daemon, 500);
      const metrics: Record<string, Metric> = {};
      const notes: Array<string> = [];

      for (const transport of ["socket", "bridge"] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(daemon, transport, "editor-" + transport);
            const started = performance.now();
            const read = yield* readEditorFile(client.connection, paths[0]!);
            const openedMs = performance.now() - started;
            metrics[`${transport}.open_1mib_ms`] = latency(openedMs);
            const savedAt = performance.now();
            yield* writeEditorFile(client.connection, paths[0]!, read.text, read.version);
            metrics[`${transport}.save_1mib_ms`] = latency(performance.now() - savedAt);
            const budget = transport === "socket" ? 150 : 400;

            if (openedMs >= budget) notes.push(`${transport} open exceeds ${budget} ms budget`);
          })
        );
      }

      const client = yield* connect(daemon, ctx.transport, "editor-tabs");
      yield* client.connection.client
        .subscribeHost({ afterSequence: null })
        .pipe(Stream.runDrain, Effect.forkScoped);
      yield* settle(ctx.quick ? 5000 : 35000);
      const bareFrom = sampler.sample().t;
      yield* settle(ctx.quick ? 3000 : 10000);
      const bare = sampler.report(bareFrom - 1, sampler.sample().t);
      yield* Effect.scoped(
        Effect.gen(function* () {
          let snapshots = 0;
          let changes = 0;

          for (const path of paths) {
            let first = true;
            yield* client.connection.client["files.watchFile"]({ path }).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  if (first) {
                    snapshots++;
                    first = false;
                  } else changes++;
                })
              ),
              Stream.runDrain,
              Effect.forkScoped
            );
          }

          yield* waitUntil(() => snapshots === 20, 10000, "20 tab watch snapshots");
          yield* settle(ctx.quick ? 5000 : 35000);
          const from = sampler.sample().t;
          yield* settle(ctx.quick ? 5000 : 30000);
          const report = sampler.report(from - 1, sampler.sample().t);
          metrics.tabs20_cpu_pct = cpu(report.cpuAvgPct);
          metrics.tabs20_cpu_over_unwatched_pct = cpu(report.cpuAvgPct - bare.cpuAvgPct, {
            tolerance: { relative: 1, absolute: 0.3 },
          });
          metrics.tabs20_daemon_rss_mib = rss(memory(report.rssBytes.median));

          if (report.footprintBytes)
            metrics.tabs20_daemon_footprint_mib = memory(report.footprintBytes.median);

          if (report.wakeupsPerSec !== null && bare.wakeupsPerSec !== null) {
            metrics.tabs20_wakeups_per_s = throughput(report.wakeupsPerSec, "/s", {
              kind: "count",
              better: "lower",
            });
            metrics.tabs20_wakeups_over_unwatched_per_s = throughput(
              report.wakeupsPerSec - bare.wakeupsPerSec,
              "/s",
              { kind: "count", better: "lower" }
            );
          }

          metrics.tabs20_idle_events = { value: changes, unit: "", kind: "count", better: "lower" };
        })
      );
      notes.push(
        "Bridge is a fake remote Host on loopback; actual SSH/network latency remains unmeasured."
      );
      notes.push(
        "Measures Daemon open/save and watch cost; renderer typing and whole-app tab memory are Desktop App checks. Unwatched and watched windows share a connected Client subscribed to the Host feed."
      );

      return { metrics, notes };
    }),
};
