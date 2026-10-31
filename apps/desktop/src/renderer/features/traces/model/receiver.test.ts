import { expect, test } from "bun:test";
import { TraceAvailability, type TracesSnapshot } from "@polaris/protocol";
import { receiverLine } from "./receiver.ts";

const snapshot = (patch: Partial<TracesSnapshot>): TracesSnapshot => ({
  availability: TraceAvailability.cases.Listening.make({}),
  userExported: false,
  endpoint: "http://127.0.0.1:4319/otlp/tok_secret",
  traces: [],
  total: 0,
  ...patch,
});

test("the receiver line names host and port and never the endpoint's token", () => {
  const line = receiverLine(snapshot({}));

  expect(line.text).toBe("Receiving on 127.0.0.1:4319");
  expect(JSON.stringify(line)).not.toContain("tok_secret");
});

test("an unavailable receiver says so with its code and owner, the message as detail", () => {
  const availability = TraceAvailability.cases.Unavailable.make({
    code: "E-TRACE-PORT-IN-USE",
    message: "127.0.0.1:4319 is in use by another process",
    owner: "otelcol-contrib (pid 4127)",
  });

  expect(receiverLine(snapshot({ availability }))).toEqual({
    text: "Not receiving · E-TRACE-PORT-IN-USE · in use by otelcol-contrib (pid 4127)",
    detail: "127.0.0.1:4319 is in use by another process",
  });
});
