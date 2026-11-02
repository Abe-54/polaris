import { expect, test } from "bun:test";
import { WorkspaceId } from "@polaris/protocol";
import { SELF_CHECKOUT } from "../../traces/self/scope.ts";
import { makeSpan, NOW, withStoredTools } from "./traces.testing.ts";
import type { TraceStatsInput } from "./traces.ts";

const trace = (n: number) => n.toString(16).padStart(32, "0");

const sid = (id: number) => id.toString(16).padStart(16, "0");

const failed = (span: ReturnType<typeof makeSpan>) => ({ ...span, status: { code: 2 } });

const MINUTE = 60_000;

test("trace_stats groups spans by name and service with counts, errors, percentiles and an errored example", () =>
  withStoredTools(async (f) => {
    // Five data.query spans, two failed; the newer failure is the example despite a slower ok span.
    await f.ingest([makeSpan(1, undefined, "data.query", 10, -5 * MINUTE, trace(1))]);
    await f.ingest([failed(makeSpan(2, undefined, "data.query", 20, -4 * MINUTE, trace(2)))]);
    await f.ingest([makeSpan(3, undefined, "data.query", 500, -3 * MINUTE, trace(3))]);
    await f.ingest([failed(makeSpan(4, undefined, "data.query", 40, -2 * MINUTE, trace(4)))]);
    await f.ingest([makeSpan(5, undefined, "data.query", 30, -1 * MINUTE, trace(5))]);
    await f.ingest([makeSpan(6, undefined, "data.query", 7, -1 * MINUTE, trace(6))], "worker");
    await f.ingest([makeSpan(7, undefined, "git.status", 3, -1 * MINUTE, trace(7))]);

    const result = await f.tool("trace_stats").call({});
    const groups = result.structuredContent?.groups;

    expect(groups).toEqual([
      {
        name: "data.query",
        service: "ledger-api",
        count: 5,
        errors: 2,
        p50Ms: 30,
        p95Ms: 500,
        maxMs: 500,
        latestStart: new Date(Number(NOW / 1_000_000n) - MINUTE).toISOString(),
        example: { trace: trace(4), span: sid(4) },
      },
      expect.objectContaining({ name: "data.query", service: "worker", count: 1, errors: 0 }),
      expect.objectContaining({ name: "git.status", count: 1, errors: 0 }),
    ]);
    expect(result.content[0]!.text).toContain(
      `data.query  ledger-api  ×5  2 ERRORS  p50 30 ms  p95 500 ms  max 500 ms  latest `
    );
    expect(result.content[0]!.text).toContain(`error trace ${trace(4)} span ${sid(4)}`);

    // Without errors, the example is the group's slowest span.
    const ok = await f.tool("trace_stats").call({ name: "QUERY", status: "ok", by: "name" });
    expect(ok.structuredContent?.groups).toEqual([
      {
        name: "data.query",
        count: 4,
        errors: 0,
        p50Ms: 10,
        p95Ms: 500,
        maxMs: 500,
        latestStart: new Date(Number(NOW / 1_000_000n) - MINUTE).toISOString(),
        example: { trace: trace(3), span: sid(3) },
      },
    ]);

    const services = await f.tool("trace_stats").call({ by: "service", sort: "errors" });
    expect(services.structuredContent?.groups).toMatchObject([
      { service: "ledger-api", count: 6, errors: 2 },
      { service: "worker", count: 1, errors: 0 },
    ]);

    const limited = await f.tool("trace_stats").call({ limit: 1, sort: "slow" });
    expect(limited.structuredContent).toMatchObject({ groupCount: 3, spans: 7, truncated: false });
    expect(limited.content[0]!.text).toContain(
      "7 spans in 3 groups (1 shown; add limit or narrow filters)"
    );
  }));

test("trace_stats reads only the window: older spans count once sinceMinutes reaches them", () =>
  withStoredTools(async (f) => {
    await f.ingest([makeSpan(1, undefined, "data.query", 10, -30 * MINUTE, trace(1))]);
    await f.ingest([makeSpan(2, undefined, "data.query", 10, -90 * MINUTE, trace(2))]);
    await f.ingest([makeSpan(3, undefined, "data.query", 10, -150 * MINUTE, trace(3))]);

    const count = async (input: TraceStatsInput) =>
      (await f.tool("trace_stats").call(input)).structuredContent?.spans;

    expect(await count({})).toBe(1);
    expect(await count({ sinceMinutes: 120 })).toBe(2);
    expect(await count({ sinceMinutes: 180 })).toBe(3);

    const none = await f.tool("trace_stats").call({ sinceMinutes: 10 });
    expect(none.content[0]!.text).toEndWith(
      "(last 10 min) · none matched. Widen sinceMinutes or loosen name, service, status or attributes."
    );

    for (const input of [{ sinceMinutes: 0 }, { sinceMinutes: 7 * 24 * 60 + 1 }, { limit: 101 }])
      expect((await f.tool("trace_stats").call(input)).structuredContent?.code).toBe("E-INPUT");
  }));

test("trace_stats scope self needs Developer Mode on and the Polaris Workspace, and reads only Self-Traces", () =>
  withStoredTools(async (f) => {
    await f.ingest([makeSpan(1, undefined, "checkout.span")]);
    await f.ingest(
      [makeSpan(7, undefined, "polaris.rpc.data.query", 2, 0, trace(7))],
      "polaris-daemon",
      SELF_CHECKOUT
    );

    const off = await f.tool("trace_stats").call({ scope: "self" });
    expect(off.structuredContent).toEqual({
      code: "E-TRACE-UNAVAILABLE",
      message:
        "Polaris's own traces are readable only from the Polaris Workspace while Developer Mode is on.",
      fix: "Omit scope to read this checkout; the user can turn on Developer Mode in Settings.",
    });

    f.setDeveloperMode(true, WorkspaceId.make("ws_other"));
    expect((await f.tool("trace_stats").call({ scope: "self" })).structuredContent?.code).toBe(
      "E-TRACE-UNAVAILABLE"
    );

    f.setDeveloperMode(true);
    expect(
      (await f.tool("trace_stats").call({ scope: "self" })).structuredContent?.groups
    ).toMatchObject([{ name: "polaris.rpc.data.query", service: "polaris-daemon", count: 1 }]);
    // The checkout's own read never mixes in Self-Traces, even while they're readable.
    expect((await f.tool("trace_stats").call({})).structuredContent?.groups).toMatchObject([
      { name: "checkout.span", count: 1 },
    ]);
  }));
