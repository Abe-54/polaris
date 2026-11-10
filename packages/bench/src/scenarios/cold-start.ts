/**
 * cold-start: spawn → first successful `hello` on the socket, the Daemon's
 * memory once settled, how many modules its start-up loaded, and how long a
 * Client takes to connect through `polaris bridge` to a running Daemon.
 */
import { Effect, Option, Schema } from "effect";
import { awaitReady, connect } from "../daemon.ts";
import { settle } from "../drive.ts";
import { summarize } from "../stats.ts";
import { count, cpu, type Metric, memory, rss, type Scenario, time } from "../types.ts";

/** The line `POLARIS_DEBUG_MODULES=1` makes the Daemon print once it listens (`debug.ts`). */
const StartupModules = Schema.fromJsonString(
  Schema.Struct({
    polarisModules: Schema.Struct({ all: Schema.Number, polaris: Schema.Number }),
  })
);

const decodeStartupModules = Schema.decodeUnknownOption(StartupModules);

/** The module counts in the Daemon's logs; none from a compiled binary (one bundle). */
export const startupModules = (logs: string) => {
  for (const line of logs.split("\n")) {
    const decoded = decodeStartupModules(line);

    if (Option.isSome(decoded) && decoded.value.polarisModules.all > 0)
      return decoded.value.polarisModules;
  }

  return null;
};

/**
 * The start-up graph does not depend on timing, so this gate has no noise: a few modules more
 * pass, a feature's worth of eager imports (~0.1 MiB each) fails until it loads on first use.
 */
const MODULES_TOLERANCE = { relative: 0.03, absolute: 5 };

export const coldStart: Scenario = {
  name: "cold-start",
  description: "spawn → first hello; RSS after settle; bridge connect time",
  run: (ctx) =>
    Effect.gen(function* () {
      const spawns = ctx.quick ? 3 : 5;
      const hello: Array<number> = [];
      const rssSamples: Array<number> = [];
      const footprint: Array<number> = [];
      const bridge: Array<number> = [];
      const modules: Array<{ readonly all: number; readonly polaris: number }> = [];
      let idleCpu = 0;

      for (let i = 0; i < spawns; i++) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const daemon = yield* ctx.launch({ env: { POLARIS_DEBUG_MODULES: "1" } });
            const sampler = yield* ctx.sample(daemon, 100);
            hello.push(yield* awaitReady(daemon));
            const ready = sampler.now();
            yield* settle(2000);
            const s = sampler.sample();
            rssSamples.push(s.rssBytes);

            if (s.footprintBytes !== null) footprint.push(s.footprintBytes);
            const loaded = startupModules(daemon.logs());

            if (loaded !== null) modules.push(loaded);
            const t0 = performance.now();
            yield* Effect.scoped(connect(daemon, "bridge"));
            bridge.push(performance.now() - t0);

            // CPU in the settled window, before the bridge connect.
            if (i === 0) idleCpu = sampler.report(ready + 500, ready + 2000).cpuAvgPct;
          })
        );
      }

      const metrics: Record<string, Metric> = {};

      Object.assign(metrics, {
        hello_ms: time(summarize(hello).median),
        hello_max_ms: time(summarize(hello).max, { info: true }),
        rss_settled_mib: rss(memory(summarize(rssSamples).median)),
      } satisfies Record<string, Metric>);

      if (footprint.length > 0) {
        metrics.footprint_settled_mib = memory(summarize(footprint).median);
      }

      if (modules.length > 0) {
        metrics.startup_modules = count(summarize(modules.map((m) => m.all)).median, "modules", {
          tolerance: MODULES_TOLERANCE,
        });

        metrics.startup_polaris_modules = count(
          summarize(modules.map((m) => m.polaris)).median,
          "modules",
          { info: true }
        );
      }

      metrics.bridge_connect_ms = time(summarize(bridge).median);
      metrics.settle_cpu_pct = cpu(idleCpu, { info: true });

      return {
        metrics,
        notes: [`${spawns} spawns per run; hello polled every 2 ms over the Unix socket`],
      };
    }),
};
