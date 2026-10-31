import { describe, expect, test } from "bun:test";
import { SpanDetail, TraceDetail, TracesSnapshot } from "@polaris/protocol";
import { Predicate, Schema } from "effect";
import { fixtureSnapshot, fixtureTracesApi } from "./fixtureApi.ts";
import {
  BIG_TRACE,
  ERROR_TRACE,
  FIXTURE_DETAILS,
  FIXTURE_SESSION,
  PARTIAL_TRACE,
} from "./fixtures.ts";

const at = { hostKey: "local", sessionId: FIXTURE_SESSION };

const detail = (id: string) => {
  const found = FIXTURE_DETAILS.find((d) => d.summary.id === id);

  if (found === undefined) throw new Error(`no fixture trace ${id}`);

  return found;
};

const depth = (d: TraceDetail, id: string | null): number => {
  const span = d.spans.find((s) => s.id === id);

  return span === undefined ? 0 : 1 + depth(d, span.parentId);
};

describe("Traces fixtures", () => {
  test("every trace, span and snapshot decodes against the protocol", async () => {
    for (const d of FIXTURE_DETAILS) Schema.decodeUnknownSync(TraceDetail)(d);

    for (const scene of ["traces", "empty", "unavailable", "userExported"] as const)
      Schema.decodeUnknownSync(TracesSnapshot)(fixtureSnapshot(scene));
    const span = await fixtureTracesApi().span(at, ERROR_TRACE.id, "85cae0a4b6d8fa25");

    if (!span.ok) throw new Error(span.error.message);
    Schema.decodeUnknownSync(SpanDetail)(span.value);
  });

  test("the overdue run has 434 spans over two services, ×214 repeated calls, 4 levels deep", () => {
    const d = detail(BIG_TRACE.id);
    const perService = Object.groupBy(d.spans, (s) => s.service);
    const calls = d.spans.filter((s) => s.name === "GET fx-rates.internal/rates");

    expect({
      spans: d.summary.spans,
      services: d.summary.services,
      ledger: perService["ledger-api"]?.length,
      fx: perService["fx-rates"]?.length,
      repeats: calls.length,
      parents: new Set(calls.map((s) => s.parentId)).size,
      depth: Math.max(...d.spans.map((s) => depth(d, s.id))),
      ms: d.summary.durationMs,
      update: d.spans.find((s) => s.name === "UPDATE invoices")?.durationMs,
    }).toEqual({
      spans: 434,
      services: ["fx-rates", "ledger-api"],
      ledger: 220,
      fx: 214,
      repeats: 214,
      parents: 1,
      depth: 4,
      ms: 840,
      update: 112,
    });
  });

  test("spans start in order and stay inside the root's time", () => {
    for (const d of FIXTURE_DETAILS) {
      const starts = d.spans.map((s) => BigInt(s.startTimeUnixNano));
      const root = d.spans.find((s) => s.id === d.summary.rootSpanId);

      expect(starts).toEqual(starts.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

      if (root?.parentId === null)
        expect(
          d.spans.every(
            (s) =>
              BigInt(s.startTimeUnixNano) >= BigInt(root.startTimeUnixNano) &&
              BigInt(s.endTimeUnixNano) <= BigInt(root.endTimeUnixNano)
          )
        ).toBe(true);
    }
  });

  test("the failing test carries an exception event and its logs, newest first", async () => {
    const d = detail(ERROR_TRACE.id);
    const root = await fixtureTracesApi().span(at, ERROR_TRACE.id, d.summary.rootSpanId);

    if (!root.ok) throw new Error(root.error.message);

    expect([d.summary.status, d.summary.errors]).toEqual(["error", 2]);
    expect(root.value.span.events.map((e) => [e.name, e.attributes["exception.type"]])).toEqual([
      ["exception", "AssertionError"],
    ]);
    expect(root.value.logs.map((l) => l.severityText)).toEqual(["INFO", "ERROR"]);
    expect(root.value.logCount).toBe(2);
  });

  test("the partial trace keeps a span whose parent retention removed", () => {
    const d = detail(PARTIAL_TRACE.id);
    const ids = new Set(d.spans.map((s) => s.id));

    expect(d.summary.partial).toBe(true);
    expect(d.spans.some((s) => s.parentId !== null && !ids.has(s.parentId))).toBe(true);
  });

  test("traces come from three Turns and between Turns", () => {
    const turns = new Set(FIXTURE_DETAILS.map((d) => d.summary.turn?.number ?? null));

    expect([...turns].toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([null, 10, 11, 12]);
  });

  test("the port conflict and the user's own exporter have no endpoint and no traces", () => {
    const unavailable = fixtureSnapshot("unavailable");
    const exported = fixtureSnapshot("userExported");

    expect(
      Predicate.isTagged(unavailable.availability, "Unavailable")
        ? unavailable.availability.owner
        : null
    ).toBe("otelcol-contrib (pid 4127)");
    expect([unavailable.endpoint, unavailable.total]).toEqual([null, 0]);
    expect([exported.userExported, exported.endpoint, exported.total]).toEqual([true, null, 0]);
  });
});
