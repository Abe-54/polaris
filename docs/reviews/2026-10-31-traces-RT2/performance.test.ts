// RT2 repros (ENG-656) for `trace`, `traces` and SLOW history cost. Expected to FAIL on d0c65821e.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { TRACE_ID } from "../../../apps/daemon/src/traces/testing.ts";
import { makeSpan, withStoredTools } from "../../../apps/daemon/src/mcp/tools/traces.testing.ts";

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
      spans.push(makeSpan(next++, handler, `SELECT ${q % names}`, 1 + (q % 5) / 10, at + h * 0.01 + q * 0.001, id));
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
  clearInterval(timer);

  return { value, elapsed, worst };
};

test(
  "F4: `trace` on a 50k-span trace takes over 2 s and stalls the Daemon's main thread",
  () =>
    withStoredTools(async (f) => {
      await ingestAll(f.ingest, requestTrace(TRACE_ID, 500, 99, 40));
      const { value, elapsed, worst } = await mainThreadStall(() =>
        f.tool("trace").call({ id: TRACE_ID })
      );
      console.log(`trace 50k spans: ${elapsed.toFixed(0)} ms, main-thread stall ${worst.toFixed(0)} ms`);

      expect(value.isError).not.toBe(true);
      expect(elapsed).toBeLessThan(2_000);
      expect(worst).toBeLessThan(250);
    }),
  300_000
);

test(
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
      console.log(`trace with history over 5k stored spans: ${elapsed.toFixed(0)} ms; a concurrent list waited ${listMs.toFixed(0)} ms`);

      expect(elapsed).toBeLessThan(2_000);
      expect(listMs).toBeLessThan(250);
    }),
  600_000
);

test(
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
      console.log(`traces over 20 error traces of 5k spans: ${elapsed.toFixed(0)} ms, stall ${worst.toFixed(0)} ms`);

      expect(value.isError).not.toBe(true);
      expect(elapsed).toBeLessThan(1_000);
    }),
  300_000
);

test(
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
      console.log(`span on a 50k-span trace: ${elapsed.toFixed(0)} ms; store.span alone ${direct.toFixed(0)} ms`);

      expect(value.isError).not.toBe(true);
      expect(elapsed).toBeLessThan(direct * 3 + 50);
    }),
  300_000
);
