import { expect, test } from "bun:test";
import {
  NotFound,
  ProfileError,
  TraceError,
  TraceSettingsError,
  Unsupported,
} from "@polaris/protocol";
import { toTracesIpcError } from "./traces.ts";

test.each([
  [
    "TraceError",
    new TraceError({
      code: "E-TRACE-AMBIGUOUS",
      message: "2 traces start with 4f1c",
      fix: "use more of the id",
    }),
    {
      code: "E-TRACE-AMBIGUOUS",
      message: "2 traces start with 4f1c",
      fix: "use more of the id",
    },
  ],
  [
    "TraceSettingsError",
    new TraceSettingsError({
      code: "E-TRACE-SETTINGS-INVALID",
      message: "Forward URL carries credentials",
      fix: "Keep the token in the app's headers",
    }),
    {
      code: "E-TRACE-SETTINGS-INVALID",
      message: "Forward URL carries credentials",
      fix: "Keep the token in the app's headers",
    },
  ],
  [
    "ProfileError",
    new ProfileError({
      code: "E-PROFILE-PROCESS-NOT-OWNED",
      message: "Polaris didn't start this process",
      fix: "Start it from an agent session or a Polaris terminal",
    }),
    {
      code: "E-PROFILE-PROCESS-NOT-OWNED",
      message: "Polaris didn't start this process",
      fix: "Start it from an agent session or a Polaris terminal",
    },
  ],
])("a %s keeps its code and fix across IPC", (_tag, error, ipc) => {
  expect(toTracesIpcError(error)).toEqual(ipc);
});

test.each([
  ["traces", "Traces need a newer daemon on this host"],
  ["traces.compare", "Comparing traces needs a newer daemon on this host"],
  ["traces.settings", "Traces settings need a newer daemon on this host"],
  ["traces.profiles", "Profiles need a newer daemon on this host"],
])("an older Daemon lacking %s names the upgrade", (capability, message) => {
  expect(toTracesIpcError(new Unsupported({ capability }))).toEqual({
    code: "Unsupported",
    message,
  });
});

test("other Host failures keep their code", () => {
  expect(toTracesIpcError(new NotFound({ what: "Host", id: "offline" })).code).toBe("NotFound");
});
