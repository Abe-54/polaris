import { describe, expect, test } from "bun:test";
import { SELF_TRACE_BATCH_SPANS, SelfTraceBatch, type SelfSpan } from "@polaris/protocol";
import { Schema } from "effect";
import {
  openSpanBuffer,
  SELF_TRACE_BUFFER_BYTES,
  SELF_TRACE_BUFFER_MS,
  utf8Length,
} from "./buffer.ts";

const span = (index: number, padding = 0): SelfSpan => ({
  traceId: "1".repeat(32),
  id: index.toString(16).padStart(16, "0"),
  parentId: null,
  name: `span ${index}`,
  kind: "internal",
  status: "ok",
  statusMessage: "",
  traceState: "",
  startTimeUnixNano: "1000000",
  endTimeUnixNano: "2000000",
  attributes: { pad: "x".repeat(padding) },
  resource: { "service.name": "polaris-mobile" },
  scope: { name: "polaris-mobile", version: "1", attributes: {} },
  events: [],
  links: [],
  droppedAttributes: 0,
  droppedEvents: 0,
  droppedLinks: 0,
});

const names = (batch: ReadonlyArray<{ span: SelfSpan }>) => batch.map((entry) => entry.span.name);

const validBatch = Schema.is(SelfTraceBatch);

describe("the Self-Trace buffer", () => {
  test("holds at most 1 MiB, dropping the oldest", () => {
    const buffer = openSpanBuffer();

    for (let index = 0; index < 1200; index += 1) buffer.push(span(index, 1000), 0);

    expect(buffer.bytes()).toBeLessThanOrEqual(SELF_TRACE_BUFFER_BYTES);
    expect(buffer.bytes()).toBeGreaterThan(SELF_TRACE_BUFFER_BYTES - 2000);
    const all = [];

    for (let batch = buffer.take(0); batch.length > 0; batch = buffer.take(0)) all.push(...batch);

    expect(names(all).at(-1)).toBe("span 1199");
    expect(names(all)).not.toContain("span 0");
  });

  test("drops Spans buffered more than 5 minutes ago", () => {
    const buffer = openSpanBuffer();

    buffer.push(span(1), 0);
    buffer.push(span(2), 60_000);

    expect(names(buffer.take(SELF_TRACE_BUFFER_MS + 30_000))).toEqual(["span 2"]);
  });

  test("hands out batches that ingestSelf accepts, by count and by bytes", () => {
    const buffer = openSpanBuffer();

    for (let index = 0; index < SELF_TRACE_BATCH_SPANS + 10; index += 1)
      buffer.push(span(index), 0);
    const byCount = buffer.take(0);

    expect(byCount).toHaveLength(SELF_TRACE_BATCH_SPANS);
    expect(names(buffer.take(0))).toHaveLength(10);

    for (let index = 0; index < 60; index += 1) buffer.push(span(index, 20_000), 0);
    const bySize = buffer.take(0);

    expect(bySize.length).toBeLessThan(60);
    expect(
      validBatch({ service: "polaris-mobile", spans: bySize.map((entry) => entry.span) })
    ).toBe(true);
  });

  test("a batch put back is sent first, ahead of newer Spans", () => {
    const buffer = openSpanBuffer();

    buffer.push(span(1), 0);
    const batch = buffer.take(0);
    buffer.push(span(2), 1);
    buffer.restore(batch, 2);

    expect(names(buffer.take(2))).toEqual(["span 1", "span 2"]);
  });

  test("counts UTF-8 bytes as the wire does", () => {
    const text = "aé€😀";

    expect(utf8Length(text)).toBe(new TextEncoder().encode(text).byteLength);
  });
});
