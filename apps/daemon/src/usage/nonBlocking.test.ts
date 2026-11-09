/**
 * The first index pass over large logs runs in bounded steps in the
 * background: a session stream keeps delivering while it runs, and
 * `usage.query` answers from what is indexed, marked `indexing`, instead of
 * waiting for the whole pass.
 */
import { afterEach, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Command,
  SessionId,
  SessionPlacement,
  type SessionStreamItem,
  UsageStreamItem,
} from "@polaris/protocol";
import { Duration, Effect, Fiber, Layer, Predicate, Schema, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { Engine } from "../engine/Engine.ts";
import {
  cid,
  engineLayer,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "../engine/testing.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { UsageSessions } from "./sessions.ts";
import {
  claudeLine,
  codexMeta,
  codexTokenCount,
  codexTurnContext,
  type FixtureHost,
  fixtureHost,
} from "./testing.ts";
import { UsageIndexLive } from "./UsageIndex.ts";
import { UsageRpcs, UsageRpcsLive } from "./UsageRpcs.ts";

const hosts: Array<FixtureHost> = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.cleanup();
});

const isUsageChanged = Schema.is(UsageStreamItem.cases.UsageChanged);

/** This thread's own CPU time: clock_gettime on POSIX, GetThreadTimes (kernel plus user) on Windows. */
const clock =
  process.platform === "win32"
    ? dlopen("kernel32.dll", {
        GetCurrentThread: { args: [], returns: FFIType.u64 },
        GetThreadTimes: {
          args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
      })
    : dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
        clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      });

const CLOCK_THREAD_CPUTIME_ID = process.platform === "darwin" ? 16 : 3;

const times = new BigInt64Array(4);

/**
 * The CPU time of the thread running the Daemon's code, in ms. Unlike the process's, it
 * leaves out the other threads (GC, I/O, a worker's earlier test files) and stops while the thread is paused.
 */
const threadCpuMs = () => {
  if ("GetThreadTimes" in clock.symbols) {
    const k32 = clock.symbols;
    const at = (i: number) => times.subarray(i, i + 1);
    k32.GetThreadTimes(k32.GetCurrentThread(), at(0), at(1), at(2), at(3));

    // Kernel plus user time, as FILETIMEs: 100 ns ticks.
    return Number(times[2]! + times[3]!) / 1e4;
  }

  clock.symbols.clock_gettime(CLOCK_THREAD_CPUTIME_ID, times);
  const [seconds = 0n, nanoseconds = 0n] = times;

  return Number(seconds) * 1000 + Number(nanoseconds) / 1e6;
};

/** When a delta arrived, in wall time and in the CPU time of this thread. */
interface Arrival {
  readonly wallMs: number;
  readonly cpuMs: number;
}

const gaps = (arrivals: ReadonlyArray<Arrival>, key: keyof Arrival) =>
  arrivals.slice(1).map((arrival, i) => arrival[key] - arrivals[i]![key]);

/**
 * The longest the session waited between deltas because this thread was busy. A
 * stall is long in wall time and in the thread's CPU time; a loaded machine pausing
 * the thread is long in wall time only, so each gap counts as the lesser of the two.
 */
const worstBusyGap = (arrivals: ReadonlyArray<Arrival>) => {
  const cpu = gaps(arrivals, "cpuMs");

  return Math.max(...gaps(arrivals, "wallMs").map((wall, i) => Math.min(wall, cpu[i]!)));
};

/** ~220 MB of logs: Codex rollouts whose usage lines sit among large tool outputs, and a long Claude transcript. */
const largeLogs = (host: FixtureHost) => {
  const filler = JSON.stringify({ type: "response_item", payload: { output: "x".repeat(20_000) } });
  let expectedOutput = 0;

  for (let f = 0; f < 3; f++) {
    const lines = [
      JSON.stringify(codexMeta(`big-${f}`, "2026-09-01T00:00:00Z")),
      JSON.stringify(codexTurnContext("2026-09-01T00:00:00Z", "gpt-5.5")),
    ];

    for (let t = 1; t <= 3000; t++) {
      const at = new Date(
        Date.parse("2026-09-01T00:00:00Z") + f * 3_600_000 + t * 1000
      ).toISOString();

      lines.push(filler, JSON.stringify(codexTokenCount(at, { input: t * 100, output: t * 10 })));
    }

    expectedOutput += 3000 * 10;
    writeFileSync(
      join(host.codexSessions, `rollout-2026-09-01-big-${f}.jsonl`),
      `${lines.join("\n")}\n`
    );
  }

  // One long transcript: 40k responses, whose writes would be one long transaction unsliced.
  const lines = Array.from({ length: 40_000 }, (_, i) =>
    JSON.stringify({
      ...claudeLine({
        session: "claude-long",
        ts: new Date(Date.parse("2026-09-02T00:00:00Z") + i * 1000).toISOString(),
        msg: `m-${i}`,
        output: 1,
      }),
      padding: "y".repeat(500),
    })
  );

  expectedOutput += 40_000;
  writeFileSync(join(host.claudeProjects, "claude-long.jsonl"), `${lines.join("\n")}\n`);

  return expectedOutput;
};

test("a session keeps streaming while the first index pass runs over large logs", async () => {
  const host = fixtureHost();
  hosts.push(host);
  const expectedOutput = largeLogs(host);
  // Writing the logs left ~220 MB of strings, and a parallel worker its earlier files' heaps: not the pass's to collect.
  Bun.gc(true);
  const codex = makeFakeDriver("codex");

  const engine = engineLayer({
    filename: join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [codex],
  });

  const usage = UsageRpcsLive.pipe(
    Layer.provideMerge(
      UsageIndexLive({ env: host.env, dbPath: join(host.root, "usage.sqlite"), settleMs: 10 })
    ),
    Layer.provide(UsageSessions.layer)
  );

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engineService = yield* Engine;

        const dispatch = (command: Command) =>
          engineService.dispatch({ commandId: cid(), command, deviceLabel: "test" });

        const repo = fakeRepo();
        yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
        const model = yield* waitFor((m) => m.workspaces.size > 0);
        const workspace = [...model.workspaces.values()][0]!;
        const sessionId = SessionId.make("streaming");

        yield* dispatch(
          Command.cases.StartSession.make({
            sessionId,
            workspaceId: workspace.id,
            harness: "codex",
            placement: SessionPlacement.cases.InPlace.make({}),
            permissionMode: "supervised",
            model: null,
            effort: null,
            prompt: "stream",
            attachments: [],
          })
        );

        yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working");
        const harness = codex.latest(sessionId)!;
        const turnId = harness.turns[0]!.turnId;

        // The subscriber records when each delta arrives (one is emitted every 10 ms).
        const arrivals: Array<Arrival> = [];

        const subscriber = yield* Stream.runForEach(
          engineService.subscribeSession({ sessionId, afterSequence: null, turnLimit: 1 }),
          (item: SessionStreamItem) =>
            Effect.sync(() => {
              if (Predicate.isTagged(item, "Delta"))
                arrivals.push({ wallMs: performance.now(), cpuMs: threadCpuMs() });
            })
        ).pipe(Effect.forkChild);

        let streaming = true;

        const emitter = yield* Effect.gen(function* () {
          while (streaming) {
            harness.emit(
              HarnessEvent.ItemDelta({
                turnId,
                itemId: "m1",
                field: "text",
                text: "x",
              })
            );
            yield* Effect.sleep(Duration.millis(10));
          }
        }).pipe(Effect.forkChild);

        yield* waitUntil(() => arrivals.length > 10, 5000);

        // The Usage view opens: the first watch and query start the first pass.
        const client = yield* RpcTest.makeClient(UsageRpcs);
        let passEnded = false;

        yield* client["usage.watch"]({}).pipe(
          Stream.filter((item) => isUsageChanged(item) && !item.indexing),
          Stream.take(1),
          Stream.runForEach(() => Effect.sync(() => (passEnded = true))),
          Effect.forkChild
        );

        // From the last delta before the pass, so a stall at its start counts.
        const duringFrom = arrivals.length - 1;

        const all = {
          from: "2026-01-01T00:00:00Z",
          to: "2027-01-01T00:00:00Z",
          harness: null,
          sessionId: null,
        };

        const t0 = performance.now();
        const first = yield* client["usage.query"](all);
        const queryMs = performance.now() - t0;
        yield* waitUntil(() => passEnded, 120_000);
        const during = arrivals.slice(duringFrom);
        const final = yield* client["usage.query"](all);
        streaming = false;
        yield* Fiber.interrupt(emitter);
        yield* Fiber.interrupt(subscriber);

        return { first, queryMs, during, final };
      }).pipe(Effect.provide(Layer.merge(usage, engine).pipe(Layer.provideMerge(engine))))
    )
  );

  // The query answered straight away, from an index still being built.
  expect(result.queryMs).toBeLessThan(2000);
  expect(result.first.indexing).toBe(true);

  // Never held up for long: 30–70 ms here, up to 105 ms on a shared CI runner; 260–490 ms without the
  // pass's yields and write slices (docs/adr/0009, Testing).
  expect(result.during.length).toBeGreaterThan(20);

  const wall = gaps(result.during, "wallMs");
  const cpu = gaps(result.during, "cpuMs");

  const longest = wall
    .map((ms, i) => ({ wall: Math.round(ms), cpu: Math.round(cpu[i] ?? 0) }))
    .toSorted((a, b) => Math.min(b.wall, b.cpu) - Math.min(a.wall, a.cpu))
    .slice(0, 3);

  expect(worstBusyGap(result.during), JSON.stringify(longest)).toBeLessThan(150);

  // And the pass finished with every response indexed.
  expect(result.final.indexing).toBe(false);
  expect(result.final.buckets.reduce((sum, b) => sum + b.tokens.output, 0)).toBe(expectedOutput);
}, 180_000);
