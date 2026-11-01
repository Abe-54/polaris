import { describe, expect, test } from "bun:test";
import { SELF_TRACE_BATCH_SPANS } from "@polaris/protocol";
import { SELF_TRACE_BUFFER_AGE_MS, SELF_TRACE_BUFFER_BYTES, SelfTraceBuffer } from "./buffer.ts";
import { testSpan } from "./selfTraces.testing.ts";

const names = (buffer: SelfTraceBuffer, now: number) =>
  buffer.next(now)?.spans.map((span) => span.name) ?? [];

describe("SelfTraceBuffer", () => {
  test("past 1 MiB it drops the oldest Spans and keeps the newest", () => {
    const buffer = new SelfTraceBuffer();

    // 12 Spans of ~100 KiB: only the last 10 fit in 1 MiB.
    for (let n = 1; n <= 12; n++) buffer.push("svc", testSpan(n, 100 * 1024), 0);

    expect(buffer.bytes).toBeLessThanOrEqual(SELF_TRACE_BUFFER_BYTES);
    expect(buffer.size).toBe(10);
    expect(buffer.dropped).toBe(2);
    expect(names(buffer, 0)[0]).toBe("span 3");
  });

  test("Spans older than 5 minutes are dropped", () => {
    const buffer = new SelfTraceBuffer();

    buffer.push("svc", testSpan(1), 0);
    buffer.push("svc", testSpan(2), 60_000);

    expect(names(buffer, SELF_TRACE_BUFFER_AGE_MS)).toEqual(["span 1", "span 2"]);
    expect(names(buffer, SELF_TRACE_BUFFER_AGE_MS + 1)).toEqual(["span 2"]);
    expect(buffer.dropped).toBe(1);
  });

  test("a batch holds one service's Spans, at most a call's worth, oldest first", () => {
    const buffer = new SelfTraceBuffer();

    buffer.push("renderer", testSpan(0), 0);

    for (let n = 1; n <= SELF_TRACE_BATCH_SPANS + 10; n++) buffer.push("main", testSpan(n), 0);

    const first = buffer.next(0);

    expect(first?.service).toBe("renderer");
    expect(first?.spans).toHaveLength(1);

    if (first !== null) buffer.ack(first);

    const second = buffer.next(0);

    expect(second?.service).toBe("main");
    expect(second?.spans).toHaveLength(SELF_TRACE_BATCH_SPANS);
  });

  test("acknowledging a batch whose Spans were already evicted keeps the byte count right", () => {
    const buffer = new SelfTraceBuffer({ bytes: 4096, ageMs: SELF_TRACE_BUFFER_AGE_MS });

    buffer.push("svc", testSpan(1, 1000), 0);
    const inFlight = buffer.next(0);

    for (let n = 2; n <= 6; n++) buffer.push("svc", testSpan(n, 1000), 0);

    if (inFlight !== null) buffer.ack(inFlight);

    expect(buffer.bytes).toBeLessThanOrEqual(4096);
    expect(buffer.bytes).toBeGreaterThan(0);
    expect(names(buffer, 0)).not.toContain("span 1");
  });
});
