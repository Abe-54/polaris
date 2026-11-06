import { describe, expect, test } from "bun:test";
import { SpanDetail, TraceDetail, TracesSnapshot } from "@polaris/protocol";
import { Schema } from "effect";
import { fixtureSnapshot, fixtureTracesApi } from "./fixtureApi.ts";
import { ERROR_TRACE, FIXTURE_DETAILS, FIXTURE_SESSION } from "./fixtures.ts";

const at = { hostKey: "local", sessionId: FIXTURE_SESSION };

describe("Traces fixtures", () => {
  test("every trace, span and snapshot decodes against the protocol", async () => {
    for (const d of FIXTURE_DETAILS) Schema.decodeUnknownSync(TraceDetail)(d);

    for (const scene of ["traces", "empty", "unavailable", "userExported"] as const)
      Schema.decodeUnknownSync(TracesSnapshot)(fixtureSnapshot(scene));
    const span = await fixtureTracesApi().span(at, ERROR_TRACE.id, "85cae0a4b6d8fa25");

    if (!span.ok) throw new Error(span.error.message);
    Schema.decodeUnknownSync(SpanDetail)(span.value);
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
});
