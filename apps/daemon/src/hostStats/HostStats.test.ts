import { describe, expect, test } from "bun:test";
import { HOST_STATS_HISTORY, HostStatsItem } from "@polaris/protocol";
import { Effect, Fiber, Layer, type Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { HostStats } from "./HostStats.ts";
import type { HostProbe } from "./probe.ts";

const INTERVAL = 2000;

const FIRST = 500;

/** A Host whose CPU is busy 25% of each interval; counts its reads. */
const fakeProbe = () => {
  let reads = 0;

  const probe: HostProbe = {
    cores: () => 4,
    read: () => {
      reads += 1;

      return {
        cpu: { busy: reads * 50, total: reads * 200 },
        loadAverage: [1, 0.5, 0.25],
        memory: { usedBytes: reads * 1024, totalBytes: 8 * 1024 ** 3 },
        disk: { path: "/home/pi/.polaris", usedBytes: 10, totalBytes: 100 },
      };
    },
  };

  return { probe, reads: () => reads };
};

/** Starts a subscriber that collects every item it receives. */
const watcher = Effect.gen(function* () {
  const stats = yield* HostStats;
  const items: Array<HostStatsItem> = [];

  const fiber = yield* Stream.runForEach(stats.watch, (item) =>
    Effect.sync(() => items.push(item))
  ).pipe(Effect.forkScoped);

  yield* TestClock.adjust(0);

  return { items, stop: Fiber.interrupt(fiber) };
});

const samplesOf = (items: ReadonlyArray<HostStatsItem>) =>
  items.flatMap((item) => (HostStatsItem.guards.Sample(item) ? [item.sample] : []));

const historyOf = (items: ReadonlyArray<HostStatsItem>) => {
  const head = items[0];

  if (head === undefined || !HostStatsItem.guards.History(head)) throw new Error("no History");

  return head;
};

const run = <A>(
  body: (reads: () => number) => Effect.Effect<A, never, HostStats | Scope.Scope>
) => {
  const fake = fakeProbe();

  return Effect.runPromise(
    body(fake.reads).pipe(
      Effect.scoped,
      Effect.provide(
        HostStats.layer({ probe: fake.probe, intervalMs: INTERVAL, firstSampleMs: FIRST }).pipe(
          Layer.provideMerge(TestClock.layer())
        )
      )
    )
  );
};

describe("HostStats", () => {
  test("never reads the Host while no Client watches", () =>
    run((reads) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("10 minutes");

        expect(reads()).toBe(0);
      })
    ));

  test("a watch's first sample has its CPU measured, and comes well inside one interval", () =>
    run(() =>
      Effect.gen(function* () {
        const first = yield* watcher;

        expect(samplesOf(first.items)).toEqual([]);

        yield* TestClock.adjust(FIRST);

        expect(samplesOf(first.items).map((s) => s.cpuPercent)).toEqual([25]);
      })
    ));

  test("samples every interval while any Client watches, and stops with the last", () =>
    run((reads) =>
      Effect.gen(function* () {
        const first = yield* watcher;
        const second = yield* watcher;
        yield* TestClock.adjust(FIRST + INTERVAL * 2);

        // The baseline, then three samples.
        expect(reads()).toBe(4);
        expect(samplesOf(first.items).map((s) => s.cpuPercent)).toEqual([25, 25, 25]);
        expect([...historyOf(second.items).samples, ...samplesOf(second.items)]).toEqual(
          samplesOf(first.items)
        );

        yield* first.stop;
        yield* TestClock.adjust(INTERVAL);

        expect(reads()).toBe(5);

        yield* second.stop;
        yield* TestClock.adjust("10 minutes");

        expect(reads()).toBe(5);
      })
    ));

  test("a late subscriber gets the samples held, then live ones, without repeats", () =>
    run(() =>
      Effect.gen(function* () {
        const early = yield* watcher;
        yield* TestClock.adjust(FIRST + INTERVAL * (HOST_STATS_HISTORY + 4));
        const late = yield* watcher;
        yield* TestClock.adjust(INTERVAL);

        const held = historyOf(late.items);
        const all = samplesOf(early.items);

        expect({ cores: held.cores, intervalMs: held.intervalMs }).toEqual({
          cores: 4,
          intervalMs: INTERVAL,
        });
        expect(held.samples).toEqual(all.slice(-HOST_STATS_HISTORY - 1, -1));
        expect(samplesOf(late.items)).toEqual(all.slice(-1));
      })
    ));

  test("a restart after a pause measures CPU afresh and keeps the older history", () =>
    run(() =>
      Effect.gen(function* () {
        const before = yield* watcher;
        yield* TestClock.adjust(FIRST + INTERVAL);
        yield* before.stop;
        yield* TestClock.adjust("1 hour");

        const after = yield* watcher;
        yield* TestClock.adjust(FIRST);

        expect(historyOf(after.items).samples).toHaveLength(2);
        expect(samplesOf(after.items).map((s) => s.cpuPercent)).toEqual([25]);
      })
    ));
});
