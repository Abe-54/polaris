// Warnings recorded on Spans (ENG-754) show in the `trace` tree and the `span` detail.
import { expect, test } from "bun:test";
import { TRACE_ID } from "../../traces/testing.ts";
import { makeSpan, withStoredTools } from "./traces.testing.ts";

const warned = (span: ReturnType<typeof makeSpan>, messages: ReadonlyArray<string>) => {
  span.events = messages.map((message) => ({
    name: "log.warn",
    timeUnixNano: span.startTimeUnixNano,
    attributes: [
      { key: "log.severity", value: { stringValue: "warn" } },
      { key: "log.message", value: { stringValue: message } },
    ],
  }));

  return span;
};

test("a Span's warnings show in the trace tree, first message and a count, and in full in span", () =>
  withStoredTools(async (f) => {
    await f.ingest([
      makeSpan(1, undefined, "R", 100, 0),
      warned(makeSpan(2, 1, "hosts.connect", 50, 1), ["retrying the Host", "gave up"]),
    ]);

    const tree = (await f.tool("trace").call({ id: TRACE_ID, focus: "all" })).content[0]!.text;

    expect(tree).toContain("warn: retrying the Host");
    expect(tree).toContain("… 1 more log events; use span for details.");

    const span = (await f.tool("span").call({ trace: TRACE_ID, span: "0000000000000002" }))
      .content[0]!.text;

    expect(span).toContain("log.warn");
    expect(span).toContain("gave up");
  }));
