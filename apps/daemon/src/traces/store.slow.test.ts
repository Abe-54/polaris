import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  postTraces,
  until,
  spanFixture,
  traceFixture,
  TRACE_ID,
  SPAN_ID,
  withTraceFixture,
} from "./testing.ts";

test("logs correlate by trace and Span, remain redacted and are capped to newest 20", () =>
  withTraceFixture(async (f) => {
    expect((await postTraces(f.endpoint!)).status).toBe(200);
    const start = BigInt(Date.now()) * 1000000n;

    const records = Array.from({ length: 25 }, (_, i) => ({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      timeUnixNano: (start + BigInt(i)).toString(),
      body: { kvlistValue: { values: [{ key: "token", value: { stringValue: "private-log" } }] } },
      attributes: [
        { key: "index", value: { intValue: String(i) } },
        { key: "authorization", value: { stringValue: "private-log" } },
      ],
    }));

    const response = await fetch(`${f.endpoint}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] }),
    });

    expect(response.status).toBe(200);
    const detail = await Effect.runPromise(f.store.span(f.root, TRACE_ID, SPAN_ID));
    expect(detail.logCount).toBe(25);
    expect(detail.logs).toHaveLength(20);
    expect(detail.logs[0]?.attributes.index).toBe("24");
    expect(detail.logs[19]?.attributes.index).toBe("5");
    expect(JSON.stringify(detail.logs)).not.toContain("private-log");
    expect(detail.logs[0]?.attributes.authorization).toBe("[redacted]");
    expect(detail.logs[0]?.body).toEqual({ token: "[redacted]" });
  }));

test("a before cursor pages a Span's older logs without skipping or repeating tied records", () =>
  withTraceFixture(async (f) => {
    expect((await postTraces(f.endpoint!)).status).toBe(200);
    const start = BigInt(Date.now()) * 1000000n;
    // Three records share each time, so a page boundary lands inside a tie.

    const records = Array.from({ length: 45 }, (_, i) => ({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      timeUnixNano: (start + BigInt(Math.floor(i / 3))).toString(),
      body: { stringValue: `log ${i}` },
      attributes: [{ key: "index", value: { intValue: String(i) } }],
    }));

    const response = await fetch(`${f.endpoint}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] }),
    });

    expect(response.status).toBe(200);

    const pages: Array<ReadonlyArray<string>> = [];
    let before: { timeUnixNano: string; id: string } | undefined;

    for (let read = 0; read < 5; read += 1) {
      const detail = await Effect.runPromise(f.store.span(f.root, TRACE_ID, SPAN_ID, before));
      expect(detail.logCount).toBe(45);

      if (detail.logs.length === 0) break;
      pages.push(detail.logs.map((log) => JSON.stringify(log.body)));
      const last = detail.logs.at(-1)!;
      before = { timeUnixNano: last.timeUnixNano, id: last.id };
    }

    expect(pages.map((page) => page.length)).toEqual([20, 20, 5]);
    const read = pages.flat().map((body) => Number(/\d+/.exec(body)?.[0]));
    expect(new Set(read).size).toBe(45);
    // Newest first across pages: each record's time group never rises.
    const groups = read.map((i) => Math.floor(i / 3));
    expect(groups).toEqual(groups.toSorted((a, b) => b - a));
  }));

test("pressure keeps error Spans, removes ordinary Spans first and marks partial traces", () =>
  withTraceFixture(
    async (f) => {
      const root = spanFixture();
      const failed = spanFixture({ id: "1111111111111111", parentId: SPAN_ID, error: true });
      expect((await postTraces(f.endpoint!, traceFixture([root, failed]))).status).toBe(200);
      const result = await Effect.runPromise(f.store.get(f.root, TRACE_ID));
      expect(result.spans.map((span) => span.id)).toEqual(["1111111111111111"]);
      expect(result.summary.partial).toBe(true);
      expect(result.summary.errors).toBe(1);
    },
    { maxBytes: 1000 }
  ));

test("age retention keeps explicitly linked traces, and never mixes checkouts or prefixes", () =>
  withTraceFixture(
    async (f) => {
      await Effect.runPromise(f.store.list(f.root));
      expect((await postTraces(f.endpoint!)).status).toBe(200);
      await Effect.runPromise(f.store.link(f.root, TRACE_ID));
      const other = "1234567890abcdef0000000000000001";
      expect(
        (await postTraces(f.endpoint!, traceFixture([spanFixture({ traceId: other })]))).status
      ).toBe(200);
      expect((await Effect.runPromise(Effect.flip(f.store.get(f.root, "12345678")))).code).toBe(
        "E-TRACE-AMBIGUOUS"
      );
      expect(
        (await Effect.runPromise(Effect.flip(f.store.get("another-checkout", TRACE_ID)))).code
      ).toBe("E-TRACE-NOT-FOUND");
      await until(async () => (await Effect.runPromise(f.store.list(f.root))).traces.length === 1);
      const result = await Effect.runPromise(f.store.list(f.root));
      expect(result.traces.map((trace) => trace.id)).toEqual([TRACE_ID]);
      expect(result.traces[0]?.linked).toBe(true);
    },
    { maxAgeMs: 1000 }
  ));

test("worker starts on demand, flushes before quiet exit, and reopens persisted records", () =>
  withTraceFixture(
    async (f) => {
      expect(await Effect.runPromise(f.store.workerRunning)).toBe(false);
      expect((await Effect.runPromise(f.store.list(f.root))).traces).toEqual([]);
      expect(await Effect.runPromise(f.store.workerRunning)).toBe(false);
      expect((await postTraces(f.endpoint!)).status).toBe(200);
      expect(await Effect.runPromise(f.store.workerRunning)).toBe(true);
      await until(async () => !(await Effect.runPromise(f.store.workerRunning)));
      expect((await Effect.runPromise(f.store.get(f.root, TRACE_ID))).summary.spans).toBe(1);
    },
    { quietMs: 80, flushMs: 500 }
  ));

test("watch coalesces a continuous ingest stream to at most four snapshots per second", () =>
  withTraceFixture(async (f) => {
    const events: Array<{ at: number; total: number }> = [];
    const controller = new AbortController();

    const watching = Effect.runPromise(
      Stream.runForEach(f.store.watch(f.root), (page) =>
        Effect.sync(() => {
          events.push({ at: performance.now(), total: page.total });
        })
      ),
      { signal: controller.signal }
    ).catch(() => {});

    try {
      for (let i = 1; i <= 30; i++) {
        const traceId = i.toString(16).padStart(32, "0");
        expect(
          (await postTraces(f.endpoint!, traceFixture([spanFixture({ traceId })]))).status
        ).toBe(200);
        await Bun.sleep(10);
      }

      await until(() => events.at(-1)?.total === 30);
      expect(events[0]?.total).toBe(0);
      expect(events.length).toBeLessThan(8);

      for (let i = 1; i < events.length; i++)
        expect(events[i]!.at - events[i - 1]!.at).toBeGreaterThanOrEqual(245);
    } finally {
      controller.abort();
      await watching;
    }
  }));
