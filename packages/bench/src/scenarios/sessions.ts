/**
 * sessions: many concurrent Agent Sessions running scripted Turns with
 * streamed deltas, command output, tool calls and approvals, through the real
 * engine, store, streams and transport.
 *
 * Phases (each with new sessions, so the read model grows as it would):
 *   m<M>        M sessions, one Client (the dispatcher, which also answers approvals)
 *   m<M>c<C>    M sessions, C Clients all subscribed to every session
 *   burst       one session streaming deltas as fast as the engine takes them
 *   repeat      the first big phase again: memory should not grow a second time
 *
 * Latencies: dispatch → the Turn's `TurnStarted` event at the Client; Harness
 * emit → Client receive for every delta (the bench Harness stamps each delta);
 * commit → Client receive for every event (1 ms resolution).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceId } from "@polaris/protocol";
import { Effect } from "effect";
import {
  awaitReady,
  type Client,
  cleanup,
  connect,
  type Daemon,
  createTempDir,
} from "../daemon.ts";
import {
  registerWorkspace,
  type SessionWatch,
  sendTurn,
  settle,
  startSession,
  type TurnScript,
  waitUntil,
  watchSession,
} from "../drive.ts";
import type { Sampler } from "../sampler.ts";
import { SELF_SPANS_PER_BATCH, type SelfTraceTally, sendSelfTraces } from "../selfTraces.ts";
import { summarize } from "../stats.ts";
import {
  cpu,
  latency,
  type Metric,
  memory,
  peakMemory,
  type Scenario,
  type ScenarioContext,
  throughput,
  time,
} from "../types.ts";

interface Phase {
  readonly name: string;
  readonly sessions: number;
  readonly clients: number;
  readonly turns: number;
  readonly script: TurnScript;
}

const realistic = (quick: boolean): TurnScript => ({
  // 10 items; 6 of them stream 20 deltas at 50/s (an LLM's pace); one approval per Turn.
  items: 10,
  deltasPerItem: quick ? 10 : 20,
  deltaBytes: 48,
  deltaIntervalMs: 20,
  approvalEvery: 7,
  itemBytes: 400,
});

const phasesFor = (quick: boolean): ReadonlyArray<Phase> =>
  quick
    ? [
        { name: "m5", sessions: 5, clients: 1, turns: 2, script: realistic(true) },
        { name: "m10c3", sessions: 10, clients: 3, turns: 2, script: realistic(true) },
      ]
    : [
        { name: "m10", sessions: 10, clients: 1, turns: 3, script: realistic(false) },
        { name: "m50", sessions: 50, clients: 1, turns: 3, script: realistic(false) },
        { name: "m50c4", sessions: 50, clients: 4, turns: 3, script: realistic(false) },
      ];

let sessionCounter = 0;

/** A Client for the scenario; with `--client-self-traces` it flushes Self-Traces every second. */
const connectClient = (
  ctx: ScenarioContext,
  daemon: Daemon,
  label: string,
  tally: SelfTraceTally
) =>
  Effect.gen(function* () {
    const client = yield* connect(daemon, ctx.transport, label);

    if (ctx.clientSelfTraces) yield* sendSelfTraces(client, tally);

    return client;
  });

const runPhase = (
  ctx: ScenarioContext,
  daemon: Daemon,
  sampler: Sampler,
  primary: Client,
  workspaceId: WorkspaceId,
  phase: Phase,
  tally: SelfTraceTally
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const extra: Array<Client> = [];

      for (let c = 1; c < phase.clients; c++) {
        extra.push(yield* connectClient(ctx, daemon, `bench-${c}`, tally));
      }

      const clients = [primary, ...extra];
      const ids = Array.from({ length: phase.sessions }, () => `bench-s${++sessionCounter}`);
      const deltaLatencies: Array<number> = [];
      const eventLatencies: Array<number> = [];
      const approvalRoundTrips: Array<number> = [];
      const dispatchToEvent: Array<number> = [];
      const acks: Array<number> = [];
      const watches = new Map<string, Array<SessionWatch>>();

      const from = sampler.now();
      const started = performance.now();
      // Start every session; subscribe once the session exists.
      yield* Effect.forEach(
        ids,
        (id) =>
          Effect.gen(function* () {
            const t0 = performance.now();
            yield* startSession(primary, { sessionId: id, workspaceId, script: phase.script });
            acks.push(performance.now() - t0);
            const list: Array<SessionWatch> = [];

            for (const client of clients) {
              list.push(
                yield* watchSession(client, id, {
                  autoApprove: client === primary,
                  deltaLatencies,
                  eventLatencies,
                  approvalRoundTrips,
                })
              );
            }

            watches.set(id, list);
            const main = list[0]!;
            // The first Turn is committed with StartSession and arrives in the snapshot;
            // dispatch → event is measured on SendTurn.
            yield* waitUntil(() => main.turnStarted.length >= 1, 30_000, `${id} first Turn`);

            for (let turn = 1; turn < phase.turns; turn++) {
              yield* waitUntil(
                () => main.turnEnded.length >= turn && main.state === "idle",
                120_000,
                `${id} Turn ${turn} to end`
              );
              const t1 = performance.now();
              yield* sendTurn(primary, id, phase.script);
              acks.push(performance.now() - t1);
              yield* waitUntil(() => main.turnStarted.length > turn, 30_000, `${id} TurnStarted`);
              dispatchToEvent.push(main.turnStarted[turn]! - t1);
            }

            yield* waitUntil(
              () => list.every((w) => w.turnEnded.length >= phase.turns),
              120_000,
              `${id} to finish`
            );
          }),
        { concurrency: "unbounded", discard: true }
      );
      const elapsed = (performance.now() - started) / 1000;
      const report = sampler.report(from, sampler.now());
      const allWatches = [...watches.values()].flat();
      const deltas = allWatches.reduce((a, w) => a + w.deltas, 0);
      const bytes = allWatches.reduce((a, w) => a + w.deltaBytes, 0);
      const dl = summarize(deltaLatencies);
      const el = summarize(eventLatencies);
      const de = summarize(dispatchToEvent);
      const ack = summarize(acks);
      const ap = summarize(approvalRoundTrips);
      const p = phase.name;

      const metrics: Record<string, Metric> = {};

      Object.assign(metrics, {
        [`${p}.dispatch_ack_p50_ms`]: latency(ack.median),
        [`${p}.dispatch_to_event_p50_ms`]: latency(de.median),
        [`${p}.dispatch_to_event_p99_ms`]: latency(de.p99),
        [`${p}.delta_latency_p50_ms`]: latency(dl.median),
        [`${p}.delta_latency_p99_ms`]: latency(dl.p99),
        [`${p}.event_latency_p99_ms`]: latency(el.p99),
        [`${p}.approval_round_trip_p50_ms`]: latency(ap.median),
        [`${p}.deltas_per_s_per_client`]: throughput(deltas / clients.length / elapsed, "/s", {
          info: true,
        }),
        [`${p}.cpu_avg_pct`]: cpu(report.cpuAvgPct),
        [`${p}.cpu_p95_pct`]: cpu(report.cpuPct.p95),
        [`${p}.rss_peak_mib`]: peakMemory(report.rssBytes.max),
      } satisfies Record<string, Metric>);

      if (report.footprintBytes) {
        metrics[`${p}.footprint_peak_mib`] = peakMemory(report.footprintBytes.max);
      }

      metrics[`${p}.wall_s`] = time(elapsed * 1000, { info: true });

      ctx.log(
        `${p}: ${phase.sessions} sessions × ${phase.turns} Turns to ${clients.length} Client(s) in ${elapsed.toFixed(1)} s; ${deltas} deltas (${(bytes / 1e6).toFixed(1)} MB), delta p50 ${dl.median.toFixed(2)} ms p99 ${dl.p99.toFixed(2)} ms`
      );

      return metrics;
    })
  );

/** One session streaming deltas with no pause: the pipeline's ceiling. */
const runBurst = (
  ctx: ScenarioContext,
  sampler: Sampler,
  primary: Client,
  workspaceId: WorkspaceId
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const deltasPerItem = ctx.quick ? 10_000 : 40_000;

      const script: TurnScript = {
        items: 3,
        deltasPerItem,
        deltaBytes: 64,
        deltaIntervalMs: 0,
      };

      const id = `bench-s${++sessionCounter}`;
      const deltaLatencies: Array<number> = [];
      const from = sampler.sample().t - 1;
      const t0 = performance.now();
      yield* startSession(primary, { sessionId: id, workspaceId, script });
      const watch = yield* watchSession(primary, id, { deltaLatencies });
      yield* waitUntil(() => watch.turnEnded.length >= 1, 300_000, "burst Turn to end");
      const elapsed = (performance.now() - t0) / 1000;
      sampler.sample();
      const report = sampler.report(from, sampler.now());
      const dl = summarize(deltaLatencies);
      ctx.log(
        `burst: ${watch.deltas} deltas in ${elapsed.toFixed(2)} s (${(watch.deltas / elapsed).toFixed(0)}/s), p99 ${dl.p99.toFixed(1)} ms`
      );

      return {
        "burst.deltas_per_s": throughput(watch.deltas / elapsed, "/s"),
        "burst.mb_per_s": throughput(watch.deltaBytes / 1e6 / elapsed, "MB/s"),
        "burst.delta_latency_p99_ms": latency(dl.p99, { info: true }),
        "burst.cpu_avg_pct": cpu(report.cpuAvgPct, { info: true }),
        "burst.rss_peak_mib": peakMemory(report.rssBytes.max),
      } satisfies Record<string, Metric>;
    })
  );

export const sessions: Scenario = {
  name: "sessions",
  description: "concurrent scripted Agent Sessions: latency, delta throughput, CPU, memory growth",
  run: (ctx) =>
    Effect.gen(function* () {
      const daemon = yield* ctx.launch();
      yield* awaitReady(daemon);
      const sampler = yield* ctx.sample(daemon);

      const repo = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("sessions")),
        (dir) => Effect.sync(() => cleanup(dir))
      );

      mkdirSync(join(repo, "src"), { recursive: true });
      const tally: SelfTraceTally = { accepted: 0, failed: 0 };
      const primary = yield* connectClient(ctx, daemon, "bench-0", tally);
      const workspaceId = yield* registerWorkspace(primary, repo, "sessions");
      // A warm-up Turn, so `before` is taken after the Daemon's quiet release, as `after` is.
      yield* runPhase(
        ctx,
        daemon,
        sampler,
        primary,
        workspaceId,
        {
          name: "warmup",
          sessions: 1,
          clients: 1,
          turns: 1,
          script: realistic(ctx.quick),
        },
        tally
      );
      yield* settle(3000);
      const before = sampler.sample();

      const metrics: Record<string, Metric> = {};
      metrics.rss_before_mib = memory(before.rssBytes);
      const phases = phasesFor(ctx.quick);

      for (const phase of phases) {
        Object.assign(
          metrics,
          yield* runPhase(ctx, daemon, sampler, primary, workspaceId, phase, tally)
        );
      }

      Object.assign(metrics, yield* runBurst(ctx, sampler, primary, workspaceId));
      yield* settle(3000);
      const after = sampler.sample();

      // The biggest single-Client phase again: a leak shows up as a second step up.
      const repeatOf = phases.find(
        (p) =>
          p.clients === 1 &&
          p.sessions === Math.max(...phases.filter((q) => q.clients === 1).map((q) => q.sessions))
      )!;

      yield* runPhase(
        ctx,
        daemon,
        sampler,
        primary,
        workspaceId,
        { ...repeatOf, name: "repeat" },
        tally
      );
      yield* settle(3000);
      const afterRepeat = sampler.sample();
      // Last, so the snapshot's own allocation does not skew the numbers above.
      yield* ctx.peak(daemon, "after-repeat");

      metrics.rss_after_mib = peakMemory(after.rssBytes);
      metrics.rss_growth_mib = peakMemory(after.rssBytes - before.rssBytes);
      metrics.rss_growth_repeat_mib = memory(afterRepeat.rssBytes - after.rssBytes, {
        tolerance: { relative: 0.5, absolute: 10 },
      });

      if (after.footprintBytes !== null && before.footprintBytes !== null) {
        metrics.footprint_growth_mib = peakMemory(after.footprintBytes - before.footprintBytes);
      }

      const notes = [
        `phases: ${phases.map((p) => `${p.name} (${p.sessions} sessions × ${p.turns} Turns, ${p.clients} Client(s))`).join(", ")}, then burst and repeat (${repeatOf.name} again)`,
      ];

      if (ctx.clientSelfTraces) {
        notes.push(
          `each Client sent ${SELF_SPANS_PER_BATCH} Self-Trace Spans a second: ${tally.accepted} accepted, ${tally.failed} batches failed`
        );
      }

      const repeatGrowth = (afterRepeat.rssBytes - after.rssBytes) / 1024 / 1024;

      if (repeatGrowth > 20) {
        notes.push(
          `memory grew another ${repeatGrowth.toFixed(0)} MiB when the ${repeatOf.name} phase was repeated: possible leak (or the read model's per-Turn growth)`
        );
      }

      return { metrics, notes };
    }),
};
