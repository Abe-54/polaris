// RT2 repros (ENG-656) for `span`, id prefixes and input errors. Regressions from d0c65821e.
import { expect, test } from "bun:test";
import { TRACE_ID } from "../../traces/testing.ts";
import { makeSpan, withStoredTools } from "./traces.testing.ts";
import type { BoundTool } from "./index.ts";

type Result = Awaited<ReturnType<BoundTool["call"]>>;

const text = (result: Result) => result.content[0]!.text;

const sid = (id: number) => id.toString(16).padStart(16, "0");

test("F11: one long attribute (a 14k-char SQL statement) pushes the exception stack out of `span`", () =>
  withStoredTools(async (f) => {
    const failed = makeSpan(2, 1, "SELECT invoices", 40, 1);
    failed.status = { code: 2 };
    failed.attributes.push({
      key: "db.query.text",
      value: { stringValue: `SELECT * FROM invoices WHERE id IN (${"1,".repeat(7_000)}1)` },
    });
    failed.events = [
      {
        name: "exception",
        timeUnixNano: failed.startTimeUnixNano,
        attributes: [
          { key: "exception.type", value: { stringValue: "QueryError" } },
          { key: "exception.message", value: { stringValue: "too many parameters" } },
          {
            key: "exception.stacktrace",
            value: { stringValue: "at run (/tmp/trace-tool-checkout/src/invoices.ts:22:3)" },
          },
        ],
      },
    ];
    await f.ingest([makeSpan(1), failed]);
    const output = text(await f.tool("span").call({ trace: TRACE_ID, span: sid(2) }));

    expect(output.length).toBeLessThanOrEqual(16_000);
    expect(output).toContain("too many parameters");
    expect(output).toContain("src/invoices.ts:22:3");
  }));

test("F12: the 8-hex span prefix printed by `trace` is not unique within the trace, so `span` refuses it", () =>
  withStoredTools(async (f) => {
    await f.ingest([
      makeSpan(1, undefined, "R", 100, 0),
      { ...makeSpan(2, 1, "child a", 10, 1), spanId: "abcdef0100000001" },
      { ...makeSpan(3, 1, "child b", 90, 2), spanId: "abcdef0100000002" },
    ]);
    const output = text(await f.tool("trace").call({ id: TRACE_ID, focus: "all" }));
    const shown = /child b .*span ([0-9a-f]+)/.exec(output)![1]!;
    const result = await f.tool("span").call({ trace: TRACE_ID, span: shown });

    expect(result.isError).not.toBe(true);
  }));

test("F13: an uppercase trace id gets a generic E-INPUT that doesn't say ids are lowercase hex", () =>
  withStoredTools(async (f) => {
    await f.ingest([makeSpan(1)]);
    const result = await f.tool("trace").call({ id: TRACE_ID.toUpperCase() });

    expect(result.structuredContent?.code).toBe("E-INPUT");
    expect(result.structuredContent?.fix).toMatch(/lowercase|hex/i);
  }));

test("F12: trace ids remain retrievable when a colliding trace is outside the list page", () =>
  withStoredTools(async (f) => {
    const older = "abcdef01000000000000000000000001";
    const newer = "abcdef01000000000000000000000002";
    await f.ingest([makeSpan(1, undefined, "older", 1, -100, older)]);
    await f.ingest([makeSpan(1, undefined, "newer", 1, 0, newer)]);
    const output = text(await f.tool("traces").call({ turn: "all", limit: 1 }));
    const shown = output.split("\n")[1]!.split(" ")[0]!;
    const result = await f.tool("trace").call({ id: shown });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.summary).toMatchObject({ id: newer });
  }));
