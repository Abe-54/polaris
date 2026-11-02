import { expect, test } from "bun:test";
import { makeSpan, withStoredTools } from "./traces.testing.ts";

const trace = (n: number) => n.toString(16).padStart(32, "0");

const MINUTE = 60_000;

const query = (id: number, system: string, status: number, at = -(4 - id) * MINUTE) => ({
  ...makeSpan(id, undefined, "data.query", 10 * id, at, trace(id)),
  attributes: [
    { key: "db.system.name", value: { stringValue: system } },
    { key: "http.response.status_code", value: { intValue: String(status) } },
  ],
});

test("traces and trace_stats filter on span attribute equality, and trace_stats groups by one attribute", () =>
  withStoredTools(async (f) => {
    await f.ingest([query(1, "sqlite", 200)]);
    await f.ingest([query(2, "sqlite", 500)]);
    await f.ingest([query(3, "postgresql", 500)]);

    const traces = await f.tool("traces").call({
      turn: "all",
      attributes: [{ key: "db.system.name", value: "sqlite" }],
    });

    expect(traces.structuredContent?.traces).toMatchObject([{ id: trace(2) }, { id: trace(1) }]);

    const stats = await f.tool("trace_stats").call({
      attributes: [{ key: "http.response.status_code", value: 500 }],
      byAttribute: "db.system.name",
    });

    expect(stats.structuredContent?.groups).toMatchObject([
      { attribute: "postgresql", count: 1 },
      { attribute: "sqlite", count: 1 },
    ]);
    // Grouped by the attribute alone, a row starts with it: no name or service before it.
    expect(stats.content[0]!.text).toContain("\ndb.system.name=postgresql  ×1");

    const named = await f.tool("trace_stats").call({ byAttribute: "db.system.name", by: "name" });
    expect(named.structuredContent?.groups).toMatchObject([
      { name: "data.query", attribute: "sqlite", count: 2 },
      { name: "data.query", attribute: "postgresql", count: 1 },
    ]);
  }));

test("attribute keys outside the safe charset are refused before any read", () =>
  withStoredTools(async (f) => {
    await f.ingest([query(1, "sqlite", 200)]);

    for (const input of [
      { attributes: [{ key: `x"') OR 1=1 --`, value: "a" }] },
      { byAttribute: "a b" },
      { attributes: Array.from({ length: 6 }, () => ({ key: "a", value: "a" })) },
    ]) {
      expect((await f.tool("trace_stats").call(input)).structuredContent?.code).toBe("E-INPUT");
      expect(
        (await f.tool("traces").call({ attributes: input.attributes ?? [{ key: "", value: 1 }] }))
          .structuredContent?.code
      ).toBe("E-INPUT");
    }
  }));
