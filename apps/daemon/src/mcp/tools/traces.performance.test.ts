// RT2 repros (ENG-656) for `trace`, `traces` and SLOW history cost. Regressions from d0c65821e.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { loadavg } from "node:os";
import { TRACE_ID } from "../../traces/testing.ts";
import { makeSpan, withStoredTools } from "./traces.testing.ts";

const perf = test.skipIf(process.env.POLARIS_TRACE_PERF !== "1");

type Spans = ReturnType<typeof makeSpan>[];

const traceId = (n: number) => n.toString(16).padStart(32, "a");

/** A request trace: root, `width` handlers with `fan` queries each, names drawn from `names`. */
const requestTrace = (id: string, width: number, fan: number, names: number, at = 0): Spans => {
  const spans = [makeSpan(1, undefined, "POST /invoices/overdue", 900, at, id)];
  let next = 2;

  for (let h = 0; h < width; h++) {
    const handler = next++;
    spans.push(makeSpan(handler, 1, `handler ${h % names}`, 5 + (h % 7), at + h * 0.01, id));

    for (let q = 0; q < fan; q++)
      spans.push(
        makeSpan(
          next++,
          handler,
          `SELECT ${q % names}`,
          1 + (q % 5) / 10,
          at + h * 0.01 + q * 0.001,
          id
        )
      );
  }

  return spans;
};

const ingestAll = async (ingest: (spans: Spans) => Promise<void>, spans: Spans) => {
  for (let i = 0; i < spans.length; i += 5_000) await ingest(spans.slice(i, i + 5_000));
};

/** Longest gap between 5 ms ticks of the Daemon's main thread while `run` is in flight. */
const mainThreadStall = async <A>(run: () => Promise<A>) => {
  let last = performance.now();
  let worst = 0;

  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);

  const started = performance.now();
  const value = await run();
  const elapsed = performance.now() - started;
  worst = Math.max(worst, performance.now() - last);
  clearInterval(timer);

  return { value, elapsed, worst };
};

perf(
  "F4: `trace` on a 50k-span trace takes over 2 s and stalls the Daemon's main thread",
  () =>
    withStoredTools(async (f) => {
      await ingestAll(f.ingest, requestTrace(TRACE_ID, 500, 99, 40));

      const { value, elapsed, worst } = await mainThreadStall(() =>
        f.tool("trace").call({ id: TRACE_ID })
      );

      console.log(
        `load average ${loadavg()
          .map((value) => value.toFixed(2))
          .join("/")}`,
        `trace 50k spans: ${elapsed.toFixed(0)} ms, main-thread stall ${worst.toFixed(0)} ms`
      );

      expect(value.isError).not.toBe(true);
      expect(elapsed).toBeLessThan(2_000);
      expect(worst).toBeLessThan(250);
    }),
  300_000
);

perf(
  "F6: SLOW history scans every stored Span per name, blocking the trace worker for other RPCs",
  () =>
    withStoredTools(async (f) => {
      // Only 5k stored Spans: four earlier requests and this one, 1k Spans each.
      for (let t = 0; t < 4; t++)
        await ingestAll(f.ingest, requestTrace(traceId(t), 10, 99, 40, -100_000 + t * 1_000));
      await ingestAll(f.ingest, requestTrace(TRACE_ID, 10, 99, 40));

      let listMs = 0;

      const { elapsed } = await mainThreadStall(async () => {
        const call = f.tool("trace").call({ id: TRACE_ID });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const started = performance.now();
        await Effect.runPromise(f.store.list("/tmp/trace-tool-checkout", { limit: 20 }));
        listMs = performance.now() - started;
        await call;
      });

      console.log(
        `load average ${loadavg()
          .map((value) => value.toFixed(2))
          .join("/")}`,
        `trace with history over 5k stored spans: ${elapsed.toFixed(0)} ms; a concurrent list waited ${listMs.toFixed(0)} ms`
      );

      expect(elapsed).toBeLessThan(2_000);
      expect(listMs).toBeLessThan(250);
    }),
  600_000
);

perf(
  "F7: `traces` loads every error trace in full to print one message",
  () =>
    withStoredTools(async (f) => {
      for (let t = 0; t < 20; t++) {
        const spans = requestTrace(traceId(t), 50, 99, 40, t * 1_000);
        spans[1]!.status = { code: 2 };
        await ingestAll(f.ingest, spans);
      }

      const { value, elapsed, worst } = await mainThreadStall(() =>
        f.tool("traces").call({ turn: "all" })
      );

      console.log(
        `load average ${loadavg()
          .map((value) => value.toFixed(2))
          .join("/")}`,
        `traces over 20 error traces of 5k spans: ${elapsed.toFixed(0)} ms, stall ${worst.toFixed(0)} ms`
      );

      expect(value.isError).not.toBe(true);
      expect(elapsed).toBeLessThan(1_000);
    }),
  300_000
);

perf(
  "F8: `span` loads the whole trace only to read its start time",
  () =>
    withStoredTools(async (f) => {
      await ingestAll(f.ingest, requestTrace(TRACE_ID, 500, 99, 40));
      const spanId = (2).toString(16).padStart(16, "0");
      await Effect.runPromise(f.store.span("/tmp/trace-tool-checkout", TRACE_ID, spanId));
      const started = performance.now();
      await Effect.runPromise(f.store.span("/tmp/trace-tool-checkout", TRACE_ID, spanId));
      const direct = performance.now() - started;

      const { value, elapsed } = await mainThreadStall(() =>
        f.tool("span").call({ trace: TRACE_ID, span: spanId })
      );

      console.log(
        `load average ${loadavg()
          .map((value) => value.toFixed(2))
          .join("/")}`,
        `span on a 50k-span trace: ${elapsed.toFixed(0)} ms; store.span alone ${direct.toFixed(0)} ms`
      );

      expect(value.isError).not.toBe(true);
      expect(elapsed).toBeLessThan(direct * 3 + 50);
    }),
  300_000
);

perf(
  "F6: indexed history on 105k spans keeps trace under 500 ms and concurrent list under 100 ms",
  () =>
    withStoredTools(async (f) => {
      for (let t = 0; t < 104; t++)
        await ingestAll(f.ingest, requestTrace(traceId(t), 10, 99, 40, -200_000 + t * 1_000));
      await ingestAll(f.ingest, requestTrace(TRACE_ID, 10, 99, 40));
      await Effect.runPromise(f.store.flush);

      const retained = await Effect.runPromise(
        f.store.list("/tmp/trace-tool-checkout", { limit: 200 })
      );

      expect(retained.traces.reduce((sum, trace) => sum + trace.spans, 0)).toBe(105_105);

      const started = performance.now();
      const call = f.tool("trace").call({ id: TRACE_ID });
      await new Promise((resolve) => setTimeout(resolve, 1));
      const listStarted = performance.now();

      const listing = Effect.runPromise(
        f.store.list("/tmp/trace-tool-checkout", { limit: 20 })
      ).then((page) => ({ page, listMs: performance.now() - listStarted }));

      const result = await call;
      const elapsed = performance.now() - started;
      const { page, listMs } = await listing;
      console.log(
        `load average ${loadavg()
          .map((value) => value.toFixed(2))
          .join("/")}`,
        `trace with history over 105105 stored spans: ${elapsed.toFixed(1)} ms; concurrent list ${listMs.toFixed(1)} ms`
      );
      expect(result.isError).not.toBe(true);
      expect(page.total).toBe(105);
      expect(elapsed).toBeLessThan(500);
      expect(listMs).toBeLessThan(100);
    }),
  300_000
);
