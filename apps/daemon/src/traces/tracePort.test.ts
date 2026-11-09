import { describe, expect, test } from "bun:test";
import { TRACE_PORT, tracePort } from "./runtimeService.ts";

describe("tracePort", () => {
  test("POLARIS_TRACE_PORT moves the receiver off the user's Daemon's port", () => {
    expect(tracePort({ POLARIS_TRACE_PORT: "4329" })).toBe(4329);
  });

  test.each([undefined, "", "0", "trace", "7.5", "70000"])("%p keeps the default", (value) => {
    expect(tracePort({ POLARIS_TRACE_PORT: value })).toBe(TRACE_PORT);
  });
});
