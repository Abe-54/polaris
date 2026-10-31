import { expect, test } from "bun:test";
import { NotFound, ProfileError, TraceError, Unsupported } from "@polaris/protocol";
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
  expect(toTracesIpcError(new Unsupported({ capability: "traces.compare" }))).toEqual({
    code: "Unsupported",
    message: "Comparing traces needs a newer daemon on this host",
  });
  expect(toTracesIpcError(new NotFound({ what: "Host", id: "offline" })).code).toBe("NotFound");
});

test("a refused restart keeps the Daemon's reason; an older Daemon names Profiles' upgrade", () => {
  expect(
    toTracesIpcError(
      new ProfileError({
        code: "E-PROFILE-PROCESS-NOT-OWNED",
        message: "Polaris didn't start this process",
        fix: "Start it from an agent session or a Polaris terminal",
      })
    )
  ).toEqual({
    code: "E-PROFILE-PROCESS-NOT-OWNED",
    message: "Polaris didn't start this process",
    fix: "Start it from an agent session or a Polaris terminal",
  });
  expect(toTracesIpcError(new Unsupported({ capability: "traces.profiles" })).message).toBe(
    "Profiles need a newer daemon on this host"
  );
});
