// RT2 repros (ENG-656) for the `trace` and `traces` summaries. Expected to FAIL on d0c65821e.
import { expect, test } from "bun:test";
import { TRACE_ID } from "../../../apps/daemon/src/traces/testing.ts";
import { makeSpan, withStoredTools } from "../../../apps/daemon/src/mcp/tools/traces.testing.ts";
import type { BoundTool } from "../../../apps/daemon/src/mcp/tools/index.ts";

type Result = Awaited<ReturnType<BoundTool["call"]>>;

const text = (result: Result) => result.content[0]!.text;

const LINE = /^\+(-?[\d.]+ m?s) {2}([\d.]+ m?s) {2}( *)(\S.*)$/;

/** Read the text as the agent does: each Span line's parent is the nearest shallower line above. */
const parents = (output: string) => {
  const stack: string[] = [];
  const found = new Map<string, string | null>();

  for (const line of output.split("\n")) {
    const match = LINE.exec(line);

    if (match === null) continue;
    const depth = match[3]!.length / 2;
    const name = match[4]!.split("  ")[0]!;
    stack.length = depth;
    found.set(name, depth === 0 ? null : (stack[depth - 1] ?? "?"));
    stack[depth] = name;
  }

  return found;
};

const failing = (span: ReturnType<typeof makeSpan>, message: string) => {
  span.status = { code: 2 };
  span.events = [
    {
      name: "exception",
      timeUnixNano: span.startTimeUnixNano,
      attributes: [
        { key: "exception.type", value: { stringValue: "Error" } },
        { key: "exception.message", value: { stringValue: message } },
      ],
    },
  ];

  return span;
};

test("F1: focus slow prints lines in keep order, so a Span reads as the child of the wrong parent", () =>
  withStoredTools(async (f) => {
    await f.ingest([
      makeSpan(1, undefined, "R", 100, 0),
      makeSpan(2, 1, "X", 50, 1),
      failing(makeSpan(3, 2, "E", 5, 2), "boom"),
      makeSpan(4, 2, "C", 30, 10),
      makeSpan(5, 1, "B", 60, 30),
      makeSpan(6, 5, "B1", 55, 31),
    ]);
    const output = text(await f.tool("trace").call({ id: TRACE_ID }));
    const read = parents(output);

    expect(read.get("X")).toBe("R");
    expect(read.get("B1")).toBe("B");
    // On d0c65821e, C is printed after B1 at depth 2, so it reads as B's child.
    expect(read.get("C")).toBe("X");
  }));

test("F2: an error deeper than the cap's indentation budget is never shown, only its ancestors", () =>
  withStoredTools(async (f) => {
    const spans = Array.from({ length: 150 }, (_, i) =>
      makeSpan(i + 1, i === 0 ? undefined : i, `frame ${i}`, 300 - i, i)
    );
    failing(spans[149]!, "deep failure");
    await f.ingest(spans);
    const result = await f.tool("trace").call({ id: TRACE_ID, focus: "errors" });

    expect(text(result).length).toBeLessThanOrEqual(16_000);
    expect(text(result)).toContain("deep failure");
  }));

test("F3: one huge exception message or root name on the newest trace hides every trace in `traces`", () =>
  withStoredTools(async (f) => {
    await f.ingest([makeSpan(1, undefined, "GET /older", 10, -100, "b".repeat(32))]);
    await f.ingest([failing(makeSpan(1, undefined, "POST /invoices", 10, 0), "x".repeat(20_000))]);
    const result = await f.tool("traces").call({ turn: "all" });

    expect(text(result)).toContain(TRACE_ID.slice(0, 8));
    expect(text(result)).toContain("bbbbbbbb");
  }));

test("F5: 300 identical failing siblings push the critical path out of the summary", () =>
  withStoredTools(async (f) => {
    const spans = [makeSpan(1, undefined, "POST /invoices", 900, 0)];

    for (let i = 0; i < 300; i++)
      spans.push(failing(makeSpan(i + 2, 1, "GET /rates", 1, 1 + i), "connect ECONNREFUSED"));
    spans.push(makeSpan(400, 1, "UPDATE invoices", 600, 300));
    await f.ingest(spans);
    const output = text(await f.tool("trace").call({ id: TRACE_ID }));

    expect(output).toContain("UPDATE invoices");
    expect(output.split("ECONNREFUSED").length - 1).toBeLessThan(10);
  }));

test("F9: a child that starts before its parent (clock skew) renders a +- offset", () =>
  withStoredTools(async (f) => {
    await f.ingest([makeSpan(1, undefined, "R", 100, 0), makeSpan(2, 1, "skewed", 10, -5)]);
    const output = text(await f.tool("trace").call({ id: TRACE_ID, focus: "all" }));

    expect(output).toContain("skewed");
    expect(output).not.toContain("+-");
  }));

test("F10: the repeated-sibling group is marked SLOW by its first member, not by the group", () =>
  withStoredTools(async (f) => {
    for (let t = 0; t < 5; t++) {
      const trace = (t + 1).toString().repeat(32);
      await f.ingest([
        makeSpan(1, undefined, "R", 50, -5000 + t * 100, trace),
        ...Array.from({ length: 3 }, (_, i) =>
          makeSpan(i + 2, 1, "GET /rates", 2, -4999 + t * 100 + i, trace)
        ),
      ]);
    }
    // First member is slow (60 ms vs usual 2 ms); the other 29 are normal. p50 is 2 ms.
    await f.ingest([
      makeSpan(1, undefined, "R", 200, 0),
      makeSpan(2, 1, "GET /rates", 60, 1),
      ...Array.from({ length: 29 }, (_, i) => makeSpan(i + 3, 1, "GET /rates", 2, 70 + i * 3)),
    ]);
    const output = text(await f.tool("trace").call({ id: TRACE_ID }));
    const group = output.split("\n").find((line) => line.includes("×30 GET /rates"))!;

    expect(group).toContain("p50 2 ms");
    // The group line says SLOW (usually 2 ms) though its p50 is the usual 2 ms.
    expect(group).not.toContain("SLOW");
  }));
