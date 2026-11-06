import { describe, expect, test } from "bun:test";
import type { SelfTraceBatch } from "@polaris/protocol";
import { testSpan } from "./selfTraces.testing.ts";
import {
  makeSelfTraceExporter,
  type SelfTraceClock,
  type SelfTraceSendOutcome,
} from "./exporter.ts";

/** A clock whose timers run only when the test advances it. */
const fakeClock = () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();

  const clock: SelfTraceClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = nextId++;

      timers.set(id, { at: now + ms, run });

      return () => void timers.delete(id);
    },
  };

  const advance = async (ms: number) => {
    now += ms;

    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.run();
    }
    // Let the send's promise settle.

    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { clock, advance, armed: () => timers.size };
};

const fakeHost = (outcomes: Array<SelfTraceSendOutcome> = []) => {
  const batches: Array<SelfTraceBatch> = [];

  const send = async (batch: SelfTraceBatch) => {
    const outcome = outcomes.shift() ?? "sent";

    if (outcome === "sent") batches.push(batch);

    return outcome;
  };

  return { batches, send };
};

describe("Self-Trace exporter", () => {
  test("while off it keeps nothing, arms no timer and sends nothing", async () => {
    const { clock, advance, armed } = fakeClock();
    const host = fakeHost();
    const exporter = makeSelfTraceExporter({ send: host.send, clock });

    exporter.record("polaris-desktop-main", testSpan(1));
    await advance(10_000);

    expect(armed()).toBe(0);
    expect(exporter.held().spans).toBe(0);
    expect(host.batches).toHaveLength(0);
  });

  test("while on, Spans reach the Host in one batch under their service", async () => {
    const { clock, advance } = fakeClock();
    const host = fakeHost();
    const exporter = makeSelfTraceExporter({ send: host.send, clock, flushDelayMs: 1_000 });

    exporter.setEnabled(true);
    exporter.record("polaris-desktop-main", testSpan(1));
    exporter.record("polaris-desktop-main", testSpan(2));
    await advance(1_000);

    expect(host.batches).toEqual([
      { service: "polaris-desktop-main", spans: [testSpan(1), testSpan(2)] },
    ]);
    expect(exporter.held().spans).toBe(0);
  });

  test("an unreachable Host keeps the Spans and gets them on a later try", async () => {
    const { clock, advance, armed } = fakeClock();
    const host = fakeHost(["unreachable", "unreachable"]);

    const exporter = makeSelfTraceExporter({
      send: host.send,
      clock,
      flushDelayMs: 0,
      retryMs: { initial: 100, max: 1_000 },
    });

    exporter.setEnabled(true);
    exporter.record("svc", testSpan(1));
    await advance(0);
    await advance(100);

    expect(host.batches).toHaveLength(0);
    expect(exporter.held().spans).toBe(1);
    expect(armed()).toBe(1);

    await advance(200);

    expect(host.batches.map((batch) => batch.spans)).toEqual([[testSpan(1)]]);
    expect(armed()).toBe(0);
  });

  test("turning off drops held Spans and cancels the retry", async () => {
    const { clock, advance, armed } = fakeClock();
    const host = fakeHost(["unreachable"]);
    const exporter = makeSelfTraceExporter({ send: host.send, clock, flushDelayMs: 0 });

    exporter.setEnabled(true);
    exporter.record("svc", testSpan(1));
    await advance(0);
    exporter.setEnabled(false);

    expect(exporter.held().spans).toBe(0);
    expect(armed()).toBe(0);

    exporter.setEnabled(true);
    await advance(120_000);

    expect(host.batches).toHaveLength(0);
  });

  test("a send that never answers times out and the Spans go on the next try", async () => {
    const { clock, advance } = fakeClock();
    const batches: Array<SelfTraceBatch> = [];
    let calls = 0;

    const exporter = makeSelfTraceExporter({
      send: (batch) => {
        calls += 1;

        if (calls === 1) return new Promise(() => undefined);
        batches.push(batch);

        return Promise.resolve("sent");
      },
      clock,
      flushDelayMs: 0,
      sendTimeoutMs: 5_000,
      retryMs: { initial: 100, max: 1_000 },
    });

    exporter.setEnabled(true);
    exporter.record("svc", testSpan(1));
    await advance(0);
    await advance(5_000);
    exporter.record("svc", testSpan(2));
    await advance(100);

    expect(batches.map((batch) => batch.spans)).toEqual([[testSpan(1), testSpan(2)]]);
  });

  test("a run of failed sends is logged once, and again after a success", async () => {
    const { clock, advance } = fakeClock();
    const host = fakeHost(["unreachable", "unreachable", "sent", "unreachable"]);
    const logs: Array<string> = [];

    const exporter = makeSelfTraceExporter({
      send: host.send,
      clock,
      flushDelayMs: 0,
      retryMs: { initial: 100, max: 100 },
      log: (message) => logs.push(message),
    });

    exporter.setEnabled(true);
    exporter.record("svc", testSpan(1));
    await advance(0);
    await advance(100);
    await advance(100);
    exporter.record("svc", testSpan(2));
    await advance(0);

    expect(logs).toHaveLength(2);
  });

  test("a refused batch is dropped rather than retried", async () => {
    const { clock, advance, armed } = fakeClock();
    const host = fakeHost(["dropped"]);
    const exporter = makeSelfTraceExporter({ send: host.send, clock, flushDelayMs: 0 });

    exporter.setEnabled(true);
    exporter.record("svc", testSpan(1));
    await advance(0);

    expect(exporter.held().spans).toBe(0);
    expect(armed()).toBe(0);
  });
});
