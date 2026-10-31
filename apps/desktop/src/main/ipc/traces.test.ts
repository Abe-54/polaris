import { expect, test } from "bun:test";
import { NotFound, TraceError, Unsupported } from "@polaris/protocol";
import { toTracesIpcError } from "./traces.ts";

test("a TraceError keeps its E-TRACE code and fix across IPC", () => {
  expect(
    toTracesIpcError(
      new TraceError({
        code: "E-TRACE-AMBIGUOUS",
        message: "2 traces start with 4f1c",
        fix: "use more of the id",
      })
    )
  ).toEqual({
    code: "E-TRACE-AMBIGUOUS",
    message: "2 traces start with 4f1c",
    fix: "use more of the id",
  });
});

test("an older Daemon names the upgrade; other Host failures keep their code", () => {
  expect(toTracesIpcError(new Unsupported({ capability: "traces" }))).toEqual({
    code: "Unsupported",
    message: "Traces need a newer daemon on this host",
  });
  expect(toTracesIpcError(new NotFound({ what: "Host", id: "offline" })).code).toBe("NotFound");
});
