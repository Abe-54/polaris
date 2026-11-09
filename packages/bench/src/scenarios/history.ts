/**
 * history: a Host with a large history (full: ~100k events over 1k Turns).
 *
 * Seeded through the real Daemon with scripted Turns (so the store is exactly
 * what the engine writes), then the Daemon restarts onto it and we measure:
 * start-up with a big store, memory once loaded (the read model keeps every
 * Turn in memory), `subscribeHost` and `subscribeSession` snapshot times,
 * and resume from an `afterSequence`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type HostStreamItem,
  Sequence,
  SessionId,
  type SessionStreamItem,
} from "@polaris/protocol";
import { Effect, Option, Predicate, Stream } from "effect";
import { awaitReady, type Client, cleanup, connect, createTempDir } from "../daemon.ts";
import {
  registerWorkspace,
  sendTurn,
  settle,
  startSession,
  type TurnScript,
  waitUntil,
  watchSession,
} from "../drive.ts";
import { type Metric, memory, peakMemory, rss, type Scenario, throughput, time } from "../types.ts";

/** Time a stream until its `Synchronized` item; returns ms and the items received. */
const timeUntilSynchronized = <A extends HostStreamItem | SessionStreamItem, E>(
  stream: Stream.Stream<A, E>
) =>
  Effect.gen(function* () {
    const t0 = performance.now();
    let items = 0;
    let bytes = 0;
    yield* stream.pipe(
      Stream.tap((item) =>
        Effect.sync(() => {
          items++;

          if (Predicate.isTagged(item, "Snapshot")) bytes = JSON.stringify(item).length;
        })
      ),
      Stream.takeUntil((item) => Predicate.isTagged(item, "Synchronized")),
      Stream.runDrain
    );

    return { ms: performance.now() - t0, items, snapshotBytes: bytes };
  });

export const history: Scenario = {
  name: "history",
  description: "large store: load time and memory, snapshot and resume times",
  run: (ctx) =>
    Effect.gen(function* () {
      const sessions = ctx.quick ? 5 : 20;
      const turnsPerSession = ctx.quick ? 20 : 50;
      // ~itemsPerTurn + 4 events per Turn (TurnStarted, TurnEnded, state changes).
      const itemsPerTurn = ctx.quick ? 46 : 96;
      const script: TurnScript = { items: itemsPerTurn, deltasPerItem: 0, itemBytes: 300 };

      const home = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("home")),
        (dir) => Effect.sync(() => cleanup(dir))
      );

      const repo = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("history")),
        (dir) => Effect.sync(() => cleanup(dir))
      );

      mkdirSync(join(repo, "src"));

      // ── Seed ───────────────────────────────────────────────────────────────
      const seeded = yield* Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* ctx.launch({ home });
          yield* awaitReady(daemon);
          const sampler = yield* ctx.sample(daemon, 500);
          const client = yield* connect(daemon, "socket", "seed");
          const workspaceId = yield* registerWorkspace(client, repo, "history");
          const t0 = performance.now();
          let midSequence = 0;
          yield* Effect.forEach(
            Array.from({ length: sessions }, (_, i) => `hist-${i}`),
            (id, i) =>
              Effect.gen(function* () {
                yield* startSession(client, { sessionId: id, workspaceId, script });
                const watch = yield* watchSession(client, id);

                for (let turn = 1; turn <= turnsPerSession; turn++) {
                  yield* waitUntil(
                    () => watch.turnEnded.length >= turn && watch.state === "idle",
                    300_000,
                    `${id} Turn ${turn}`
                  );

                  if (i === 0 && turn === Math.floor(turnsPerSession / 2)) {
                    midSequence = watch.turnEndedSequences.at(-1) ?? 0;
                  }

                  if (turn < turnsPerSession) yield* sendTurn(client, id, script);
                }
              }),
            { concurrency: "unbounded", discard: true }
          );
          const seedMs = performance.now() - t0;

          const snapshot = yield* client.connection.client
            .subscribeHost({ afterSequence: null })
            .pipe(Stream.runHead);

          const first = Option.getOrUndefined(snapshot);

          const sequence =
            first !== undefined && Predicate.isTagged(first, "Snapshot") ? first.sequence : 0;

          const report = sampler.report();

          return {
            seedMs,
            sequence,
            midSequence,
            rssPeak: report.rssBytes.max,
            footprintPeak: report.footprintBytes?.max ?? null,
          };
        })
      );

      ctx.log(
        `history: seeded ${seeded.sequence} events in ${(seeded.seedMs / 1000).toFixed(1)} s (${(seeded.sequence / (seeded.seedMs / 1000)).toFixed(0)}/s)`
      );

      // ── Restart onto the big store ─────────────────────────────────────────
      const daemon = yield* ctx.launch({ home });
      const sampler = yield* ctx.sample(daemon, 250);
      const helloMs = yield* awaitReady(daemon, 120_000);
      yield* settle(2000);
      const loaded = sampler.sample();

      const client: Client = yield* connect(daemon, ctx.transport, "history");

      const host = yield* timeUntilSynchronized(
        client.connection.client.subscribeHost({ afterSequence: null })
      );

      const session = SessionId.make("hist-0");

      const full = yield* timeUntilSynchronized(
        client.connection.client.subscribeSession({
          sessionId: session,
          afterSequence: null,
          turnLimit: null,
        })
      );

      const limited = yield* timeUntilSynchronized(
        client.connection.client.subscribeSession({
          sessionId: session,
          afterSequence: null,
          turnLimit: 10,
        })
      );

      const hostResumeFrom = Sequence.make(Math.max(0, seeded.sequence - 10_000));

      const hostResume = yield* timeUntilSynchronized(
        client.connection.client.subscribeHost({ afterSequence: hostResumeFrom })
      );

      const sessionResume = yield* timeUntilSynchronized(
        client.connection.client.subscribeSession({
          sessionId: session,
          afterSequence: Sequence.make(seeded.midSequence),
          turnLimit: null,
        })
      );

      yield* settle(1000);
      const afterSnapshots = sampler.sample();
      // After the measurements: the snapshot allocates.
      yield* ctx.peak(daemon, "after-snapshots");

      const metrics: Record<string, Metric> = {};

      Object.assign(metrics, {
        events: { value: seeded.sequence, unit: "", kind: "count", better: "higher", info: true },
        seed_events_per_s: throughput(seeded.sequence / (seeded.seedMs / 1000), "/s"),
        seed_rss_peak_mib: rss(peakMemory(seeded.rssPeak)),
      } satisfies Record<string, Metric>);

      if (seeded.footprintPeak !== null) {
        metrics.seed_footprint_peak_mib = peakMemory(seeded.footprintPeak);
      }

      metrics.restart_hello_ms = time(helloMs);
      metrics.loaded_rss_mib = rss(memory(loaded.rssBytes));

      if (loaded.footprintBytes !== null) {
        metrics.loaded_footprint_mib = memory(loaded.footprintBytes);
      }

      Object.assign(metrics, {
        host_snapshot_ms: time(host.ms),
        host_snapshot_kb: {
          value: host.snapshotBytes / 1024,
          unit: "KiB",
          kind: "count",
          better: "lower",
        },
        session_snapshot_full_ms: time(full.ms),
        session_snapshot_full_kb: {
          value: full.snapshotBytes / 1024,
          unit: "KiB",
          kind: "count",
          better: "lower",
        },
        session_snapshot_last10_ms: time(limited.ms),
        host_resume_10k_ms: time(hostResume.ms),
        host_resume_items: {
          value: hostResume.items,
          unit: "",
          kind: "count",
          better: "lower",
          info: true,
        },
        session_resume_half_ms: time(sessionResume.ms),
        session_resume_items: {
          value: sessionResume.items,
          unit: "",
          kind: "count",
          better: "lower",
          info: true,
        },
        rss_after_snapshots_mib: rss(peakMemory(afterSnapshots.rssBytes)),
      } satisfies Record<string, Metric>);

      if (afterSnapshots.footprintBytes !== null) {
        metrics.footprint_after_snapshots_mib = peakMemory(afterSnapshots.footprintBytes);
      }

      return {
        metrics,
        notes: [
          `${sessions} sessions × ${turnsPerSession} Turns × ${itemsPerTurn} items (300 B each), seeded through the Daemon over the socket`,
          "host resume replays the last 10k sequences (the Host stream skips Turn items); session resume replays half of one session",
        ],
      };
    }),
};
