/**
 * terminal: output throughput of a Bun.Terminal streaming a lot of output
 * (`yes | head -c N`) to an attached Client, with the Daemon's CPU and memory.
 */
import { attachTerminal } from "@polaris/client";
import { Effect, Predicate, Stream } from "effect";
import { awaitReady, cleanup, connect, createTempDir } from "../daemon.ts";
import { settle } from "../drive.ts";
import { cpu, type Metric, peakMemory, rss, type Scenario, throughput, time } from "../types.ts";

export const terminal: Scenario = {
  name: "terminal",
  description: "terminal output throughput to an attached Client; CPU and RSS",
  run: (ctx) =>
    Effect.gen(function* () {
      const bytes = (ctx.quick ? 10 : 50) * 1_000_000;

      const cwd = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("term")),
        (d) => Effect.sync(() => cleanup(d))
      );

      const daemon = yield* ctx.launch();
      yield* awaitReady(daemon);
      const sampler = yield* ctx.sample(daemon, 100);
      const client = yield* connect(daemon, ctx.transport, "terminal");
      yield* settle(1000);
      const base = sampler.sample();
      const rpc = client.connection.client;

      const opened = yield* rpc["terminal.open"]({
        cwd,
        cols: 120,
        rows: 40,
        // The pause lets the Client attach before output starts.
        argv: [
          "sh",
          "-c",
          `sleep 0.5; yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c ${bytes}`,
        ],
      });

      let received = 0;
      let firstAt = 0;
      let exitAt = 0;
      // Raw bytes on the blob channel when the Daemon has `terminal.binary`.
      yield* attachTerminal(
        { ...client.connection, capabilities: client.capabilities },
        opened.terminalId
      ).pipe(
        Stream.tap((item) =>
          Effect.sync(() => {
            if (Predicate.isTagged(item, "Output")) {
              if (received === 0) firstAt = performance.now();
              received += item.data.byteLength;
            } else exitAt = performance.now();
          })
        ),
        Stream.takeUntil((item) => Predicate.isTagged(item, "Exit")),
        Stream.runDrain,
        Effect.timeout("5 minutes")
      );
      const seconds = (exitAt - firstAt) / 1000;
      const report = sampler.report(base.t - 1, sampler.sample().t);
      yield* rpc["terminal.close"]({ terminalId: opened.terminalId }).pipe(Effect.ignore);
      yield* settle(1000);
      const after = sampler.sample();
      // After the measurements: the snapshot allocates.
      yield* ctx.peak(daemon, "after-output");

      const notes = [
        `${bytes / 1e6} MB of output via \`yes | head -c\`; the PTY turns \\n into \\r\\n`,
      ];

      if (received < bytes) notes.push(`received only ${received} of ${bytes} bytes`);

      const metrics: Record<string, Metric> = {};

      Object.assign(metrics, {
        mb_per_s: throughput(received / 1e6 / seconds, "MB/s"),
        stream_ms: time(seconds * 1000, { info: true }),
        cpu_avg_pct: cpu(report.cpuAvgPct),
        rss_peak_over_base_mib: rss(peakMemory(report.rssBytes.max - base.rssBytes)),
      } satisfies Record<string, Metric>);

      if (report.footprintBytes && base.footprintBytes !== null) {
        metrics.footprint_peak_over_base_mib = peakMemory(
          report.footprintBytes.max - base.footprintBytes
        );
      }

      metrics.rss_after_close_mib = rss(peakMemory(after.rssBytes));

      if (after.footprintBytes !== null)
        metrics.footprint_after_close_mib = peakMemory(after.footprintBytes);

      return { metrics, notes };
    }),
};
