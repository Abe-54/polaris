/**
 * idle: a Daemon with a few registered Workspaces (git repos) and Dormant
 * Agent Sessions, doing nothing. CPU should be ~0 and wakeups rare: on a
 * laptop or a Raspberry Pi an idle Daemon must cost nothing.
 *
 * The sessions are made Dormant the way it happens in life: they run a Turn,
 * then the Daemon restarts. Measured first with one Client connected and
 * subscribed (a Desktop App in the background, its user present: ENG-495's
 * lease, renewed once a minute), then with no Client. Neither watches host
 * stats: the Daemon samples them only while a Client does (ENG-565).
 */
import { join } from "node:path";
import { Effect, Schedule, Stream } from "effect";
import { awaitReady, cleanup, connect, createTempDir } from "../daemon.ts";
import { registerWorkspace, settle, startSession, waitUntil, watchSession } from "../drive.ts";
import { smallRepo } from "../fixtures.ts";
import { startSampler } from "../sampler.ts";
import { cpu, type Metric, memory, rss, type Scenario, throughput } from "../types.ts";

const WORKSPACES = 3;

const SESSIONS = 6;

export const idle: Scenario = {
  name: "idle",
  description: "idle Daemon with Workspaces and Dormant sessions: CPU %, wakeups, RSS",
  run: (ctx) =>
    Effect.gen(function* () {
      const windowMs = ctx.quick ? 10_000 : 30_000;

      const root = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("idle")),
        (dir) => Effect.sync(() => cleanup(dir))
      );

      const repos = Array.from({ length: WORKSPACES }, (_, i) => smallRepo(join(root, `ws${i}`)));

      // Set up: Workspaces and sessions that each ran one Turn.
      const home = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("home")),
        (dir) => Effect.sync(() => cleanup(dir))
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* ctx.launch({ home });
          yield* awaitReady(daemon);
          const client = yield* connect(daemon, "socket", "setup");
          const ids: Array<string> = [];

          for (const [i, repo] of repos.entries()) {
            const workspaceId = yield* registerWorkspace(client, repo, `ws${i}`);

            for (let s = 0; s < SESSIONS / WORKSPACES; s++) {
              const id = `idle-${i}-${s}`;
              ids.push(id);
              yield* startSession(client, {
                sessionId: id,
                workspaceId,
                script: { items: 5, deltasPerItem: 5, deltaIntervalMs: 1 },
              });
            }
          }

          for (const id of ids) {
            const watch = yield* watchSession(client, id);
            yield* waitUntil(() => watch.state === "idle", 60_000, `${id} idle`);
          }
        })
      );

      const constellations =
        process.env.POLARIS_BENCH_CONSTELLATIONS === "1"
          ? yield* Effect.promise(() => import("../idleConstellations.ts")).pipe(
              Effect.flatMap((module) => module.seedIdleGraphs(home))
            )
          : 0;

      // ADR 0088: a device with a Live Activity registered keeps the Host stream followed.
      const liveActivities =
        process.env.POLARIS_BENCH_LIVE_ACTIVITY === "1"
          ? yield* Effect.promise(() => import("../idleConstellations.ts")).pipe(
              Effect.flatMap((module) => module.seedIdleLiveActivity(home))
            )
          : 0;

      // Restart onto the same store: the sessions come back Dormant.
      const daemon = yield* ctx.launch({ home });
      yield* awaitReady(daemon);
      const sampler = yield* ctx.sample(daemon, 500);
      const metrics: Record<string, Metric> = {};

      const notes: Array<string> = [
        ...(constellations === 0
          ? []
          : [
              `${constellations} running Constellations with Dormant worker sessions re-folded from the event log; no worker Turns started during measurement`,
            ]),
        ...(liveActivities === 0
          ? []
          : [`${liveActivities} Live Activity registered (Relay route off); no work`]),
      ];

      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect(daemon, ctx.transport, "idle-client");
          yield* Stream.runDrain(
            client.connection.client.subscribeHost({ afterSequence: null })
          ).pipe(Effect.forkScoped);
          yield* watchSession(client, "idle-0-0");

          if (client.capabilities.includes("presence"))
            yield* client.connection.client["presence.report"]({ presence: "present" }).pipe(
              Effect.repeat(Schedule.spaced("60 seconds")),
              Effect.forkScoped
            );
          yield* settle(5000);
          const from = sampler.sample().t;
          yield* settle(windowMs);
          const report = sampler.report(from - 1, sampler.sample().t);
          metrics.client_cpu_avg_pct = cpu(report.cpuAvgPct, {
            tolerance: { relative: 1, absolute: 0.5 },
          });
          metrics.client_cpu_max_pct = cpu(report.cpuPct.max, { info: true });
          metrics.client_rss_mib = rss(memory(report.rssBytes.median));

          if (report.footprintBytes)
            metrics.client_footprint_mib = memory(report.footprintBytes.median);

          if (report.wakeupsPerSec !== null) {
            metrics.client_wakeups_per_s = throughput(report.wakeupsPerSec, "/s", {
              kind: "count",
              better: "lower",
              tolerance: { relative: 1, absolute: 5 },
            });
          }
        })
      );

      // A bare Bun process with one far-off timer, sampled over the same window: the floor.
      const bare = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.spawn(["bun", "-e", "setInterval(() => {}, 1 << 30)"])),
        (proc) => Effect.sync(() => proc.kill())
      );

      const floor = yield* Effect.acquireRelease(
        Effect.sync(() => startSampler({ roots: () => [bare.pid], intervalMs: 500 })),
        (s) => Effect.sync(() => s.stop())
      );

      yield* settle(3000);
      const from = sampler.sample().t;
      const floorFrom = floor.sample().t;
      yield* settle(windowMs);
      const report = sampler.report(from - 1, sampler.sample().t);
      const floorReport = floor.report(floorFrom - 1, floor.sample().t);
      metrics.bare_bun_cpu_avg_pct = cpu(floorReport.cpuAvgPct, { info: true });
      metrics.bare_bun_rss_mib = memory(floorReport.rssBytes.median, { info: true });

      if (floorReport.wakeupsPerSec !== null) {
        metrics.bare_bun_wakeups_per_s = throughput(floorReport.wakeupsPerSec, "/s", {
          kind: "count",
          better: "lower",
          info: true,
        });
      }

      metrics.noclient_cpu_avg_pct = cpu(report.cpuAvgPct, {
        tolerance: { relative: 1, absolute: 0.5 },
      });
      metrics.noclient_rss_mib = rss(memory(report.rssBytes.median));

      if (report.footprintBytes)
        metrics.noclient_footprint_mib = memory(report.footprintBytes.median);

      if (report.wakeupsPerSec !== null) {
        metrics.noclient_wakeups_per_s = throughput(report.wakeupsPerSec, "/s", {
          kind: "count",
          better: "lower",
          tolerance: { relative: 1, absolute: 5 },
        });
      }

      metrics.processes = { value: report.maxProcesses, unit: "", kind: "count", better: "lower" };

      // Judge against a bare Bun process sampled over the same window, not against zero:
      // Bun's own event loop and GC timers set the floor.
      const extraCpu = report.cpuAvgPct - floorReport.cpuAvgPct;
      metrics.noclient_cpu_over_bare_pct = cpu(extraCpu, {
        tolerance: { relative: 1, absolute: 0.3 },
      });

      if (extraCpu > 0.3) {
        notes.push(
          `idle CPU without a Client is ${report.cpuAvgPct.toFixed(2)}% of a core, ${extraCpu.toFixed(2)} points above a bare Bun process`
        );
      }

      const extraWakeups =
        report.wakeupsPerSec !== null && floorReport.wakeupsPerSec !== null
          ? report.wakeupsPerSec - floorReport.wakeupsPerSec
          : null;

      if (extraWakeups !== null && extraWakeups > 5) {
        notes.push(
          `${report.wakeupsPerSec!.toFixed(1)} wakeups/s idle with no Client, ${extraWakeups.toFixed(1)}/s above a bare Bun process: timers or polling`
        );
      }

      notes.push(
        `${WORKSPACES} Workspaces, ${SESSIONS} Dormant sessions; ${windowMs / 1000} s windows after a settle; wakeups are ${process.platform === "darwin" ? "idle + interrupt wakeups (proc_pid_rusage)" : "context switches of all threads"}`
      );

      return { metrics, notes };
    }),
};
