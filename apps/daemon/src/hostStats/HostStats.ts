/**
 * Host stats (ENG-565): a sample every interval while at least one Client
 * watches, none otherwise, so an idle Daemon never wakes for them. The first
 * comes HOST_STATS_FIRST_SAMPLE_MS after a watch starts sampling, with its CPU
 * measured from a baseline read then. The last HOST_STATS_HISTORY samples are
 * kept for the next subscriber's sparkline.
 */
import {
  HOST_STATS_HISTORY,
  HostDiskUsage,
  HostStatsItem,
  HostStatsSample,
} from "@polaris/protocol";
import { Clock, Context, Effect, Fiber, Layer, PubSub, Schedule, Stream } from "effect";
import { paths } from "../paths.ts";
import type { CpuTimes, HostProbe } from "./probe.ts";

export const HOST_STATS_INTERVAL_MS = 2000;

/** How soon after sampling (re)starts the first sample comes: a baseline is read at the start. */
export const HOST_STATS_FIRST_SAMPLE_MS = 500;

/** The busy share of all cores between two readings, 0 to 100. */
export const cpuPercent = (previous: CpuTimes, next: CpuTimes): number => {
  const total = next.total - previous.total;

  if (total <= 0) return 0;

  return Math.min(100, Math.max(0, ((next.busy - previous.busy) / total) * 100));
};

/** The real Host's probe, loaded on the first watch: a Daemon nobody watches never imports it. */
const systemProbe = Effect.map(
  Effect.promise(() => import("./probe.ts")),
  (module) => module.systemProbe(paths().root)
);

export class HostStats extends Context.Service<
  HostStats,
  {
    /** `History` first, then a `Sample` per interval; sampling runs while any stream does. */
    readonly watch: Stream.Stream<HostStatsItem>;
  }
>()("polaris/daemon/hostStats/HostStats") {
  static readonly layer = (options: HostStatsOptions = {}) =>
    Layer.effect(HostStats, makeHostStats(options));
}

export interface HostStatsOptions {
  /** Defaults to the real Host, its disk read at the Daemon home. */
  readonly probe?: HostProbe;
  readonly intervalMs?: number;
  readonly firstSampleMs?: number;
}

const makeHostStats = Effect.fnUntraced(function* (options: HostStatsOptions) {
  const intervalMs = options.intervalMs ?? HOST_STATS_INTERVAL_MS;
  const firstSampleMs = options.firstSampleMs ?? HOST_STATS_FIRST_SAMPLE_MS;
  const scope = yield* Effect.scope;
  // Sliding: a Client that stops reading loses old samples rather than growing the Daemon.
  const samples = yield* PubSub.sliding<HostStatsSample>(8);
  const history: Array<HostStatsSample> = [];
  let probe: HostProbe | null = options.probe ?? null;
  let cores: number | null = null;
  let previous: CpuTimes | null = null;
  let watchers = 0;
  let sampler: Fiber.Fiber<unknown> | null = null;

  const sampleOnce = Effect.fnUntraced(function* (host: HostProbe) {
    const reading = yield* Effect.try(() => host.read());
    const at = new Date(yield* Clock.currentTimeMillis).toISOString();

    const sample = new HostStatsSample({
      at,
      cpuPercent: previous === null ? null : cpuPercent(previous, reading.cpu),
      loadAverage: reading.loadAverage,
      memoryUsedBytes: Math.round(reading.memory.usedBytes),
      memoryTotalBytes: Math.round(reading.memory.totalBytes),
      disk: reading.disk === null ? null : new HostDiskUsage(reading.disk),
    });

    previous = reading.cpu;
    history.push(sample);

    if (history.length > HOST_STATS_HISTORY) history.shift();
    yield* PubSub.publish(samples, sample);
  });

  const logged = <A>(effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.catchCause((cause) => Effect.logWarning("host stats: a sample failed", cause))
    );

  // Unpublished: the first sample then measures CPU since it, not a whole interval later.
  const baseline = (host: HostProbe) =>
    Effect.try(() => {
      previous = host.read().cpu;
    });

  const sampling = (host: HostProbe) =>
    logged(baseline(host)).pipe(
      Effect.andThen(Effect.sleep(firstSampleMs)),
      Effect.andThen(Effect.repeat(logged(sampleOnce(host)), Schedule.spaced(intervalMs)))
    );

  const watch = (host: HostProbe) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        watchers += 1;

        if (sampler !== null) return Effect.void;
        // A restart measures CPU afresh from its baseline: the time since the last sample spans the pause.
        previous = null;

        return Effect.map(Effect.forkIn(sampling(host), scope), (fiber) => {
          sampler = fiber;
        });
      }),
      () =>
        Effect.suspend(() => {
          watchers -= 1;

          if (watchers > 0 || sampler === null) return Effect.void;
          const fiber = sampler;
          sampler = null;

          return Fiber.interrupt(fiber);
        })
    );

  return HostStats.of({
    watch: Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before sampling starts, so the first sample reaches this stream.
        const live = yield* PubSub.subscribe(samples);
        probe ??= yield* systemProbe;
        cores ??= probe.cores();

        const head = HostStatsItem.cases.History.make({
          cores,
          intervalMs,
          samples: [...history],
        });

        const sent = new Set(head.samples);
        yield* watch(probe);

        return Stream.concat(
          Stream.make(head),
          Stream.fromSubscription(live).pipe(
            Stream.filter((sample) => !sent.has(sample)),
            Stream.map((sample) => HostStatsItem.cases.Sample.make({ sample }))
          )
        );
      })
    ),
  });
});
