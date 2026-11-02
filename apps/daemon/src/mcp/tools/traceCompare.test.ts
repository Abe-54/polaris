import { expect, test } from "bun:test";
import { WorkspaceId } from "@polaris/protocol";
import { SELF_CHECKOUT } from "../../traces/self/scope.ts";
import { makeSpan, withStoredTools } from "./traces.testing.ts";

const trace = (n: number) => n.toString(16).padStart(32, "0");

const MINUTE = 60_000;

const span = (id: number, name: string, ms: number, minutesAgo: number) =>
  makeSpan(id, undefined, name, ms, -minutesAgo * MINUTE, trace(id));

test("trace_compare defaults to the last hour against the hour before it", () =>
  withStoredTools(async (f) => {
    // The hour before: a steady query and a span that then disappears.
    await f.ingest([span(1, "data.query", 10, 90), span(2, "old.job", 5, 80)]);
    // The last hour: the same query, slower, and a new span.
    await f.ingest([span(3, "data.query", 50, 30), span(4, "new.job", 5, 20)]);
    // Two hours ago and more: outside both default windows.
    await f.ingest([span(5, "ancient", 5, 150)]);

    const result = await f.tool("trace_compare").call({});

    expect(result.structuredContent).toMatchObject({
      a: { spans: 2 },
      b: { spans: 2, until: null },
      appeared: 1,
      disappeared: 1,
      changed: 1,
      unchanged: 0,
    });
    // A ends where B starts, an hour ago.
    expect(result.content[0]!.text).toMatch(
      /^A: \S+ → (\S+) · 2 spans in 2 groups\nB: \1 → now · /
    );
    expect(result.structuredContent?.changes).toMatchObject([
      { name: "new.job", change: "appeared", a: null, b: { count: 1 } },
      { name: "old.job", change: "disappeared", a: { count: 1 }, b: null },
      { name: "data.query", change: "changed", a: { p95Ms: 10 }, b: { p95Ms: 50 } },
    ]);
    expect(result.content[0]!.text).toContain(
      "data.query  ledger-api  CHANGED  ×1 → ×1  errors 0% → 0%  p95 10 ms → 50 ms  e.g. trace"
    );
    expect(result.content[0]!.text).toContain(
      "1 appeared, 1 disappeared, 1 changed by 10% or more, 0 unchanged"
    );
  }));

test("trace_compare compares two builds by the resource's service.version", () =>
  withStoredTools(async (f) => {
    await f.ingest([span(1, "data.query", 10, 2_000)], "ledger-api", undefined, "0.8.3");
    await f.ingest([span(2, "data.query", 80, 10)], "ledger-api", undefined, "0.8.4");
    await f.ingest([span(3, "data.query", 500, 5)]);

    const result = await f.tool("trace_compare").call({
      a: { version: "0.8.3" },
      b: { version: "0.8.4" },
    });

    expect(result.structuredContent).toMatchObject({
      a: { version: "0.8.3", spans: 1 },
      b: { version: "0.8.4", spans: 1 },
    });
    expect(result.structuredContent?.changes).toMatchObject([
      { name: "data.query", a: { p95Ms: 10 }, b: { p95Ms: 80 } },
    ]);
  }));

test("trace_compare refuses sides that are empty or can't default", () =>
  withStoredTools(async (f) => {
    for (const input of [
      { b: { version: "0.8.4" } },
      { b: { sinceMinutes: 10, untilMinutes: 10 } },
      { a: { sinceMinutes: 5, untilMinutes: 30 } },
      { b: { sinceMinutes: 6 * 24 * 60 } },
    ])
      expect((await f.tool("trace_compare").call(input)).structuredContent?.code).toBe("E-INPUT");

    expect(
      (await f.tool("trace_compare").call({ b: { sinceMinutes: 0 } })).structuredContent?.code
    ).toBe("E-INPUT");
  }));

test("trace_compare scope self follows the Self-Trace rule", () =>
  withStoredTools(async (f) => {
    await f.ingest([span(7, "polaris.rpc.data.query", 2, 5)], "polaris-daemon", SELF_CHECKOUT);

    expect((await f.tool("trace_compare").call({ scope: "self" })).structuredContent?.code).toBe(
      "E-TRACE-UNAVAILABLE"
    );

    f.setDeveloperMode(true, WorkspaceId.make("ws_other"));
    expect((await f.tool("trace_compare").call({ scope: "self" })).structuredContent?.code).toBe(
      "E-TRACE-UNAVAILABLE"
    );

    f.setDeveloperMode(true);
    expect(
      (await f.tool("trace_compare").call({ scope: "self" })).structuredContent?.changes
    ).toMatchObject([{ name: "polaris.rpc.data.query", change: "appeared" }]);
  }));
