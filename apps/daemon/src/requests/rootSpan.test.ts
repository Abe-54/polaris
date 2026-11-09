import { expect, test } from "bun:test";
import { readTraceContext } from "@polaris/protocol";
import { sendTraceContext } from "./rootSpan.ts";

const header = (headers: ReadonlyArray<{ name: string; value: string }>) => (name: string) =>
  headers.find((item) => item.name.toLowerCase() === name)?.value;

test("a Send without its own traceparent gets one naming the root Span", () => {
  const context = sendTraceContext([{ name: "Accept", value: "application/json" }]);
  const sent = readTraceContext(header(context.headers));

  expect(sent?.traceparent).toBe(`00-${context.traceId}-${context.spanId}-01`);
});

test("a Request's own traceparent is kept and its trace id reused", () => {
  const own = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const context = sendTraceContext([{ name: "TraceParent", value: own }]);

  expect(context.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  expect(context.headers).toEqual([{ name: "TraceParent", value: own }]);
});
