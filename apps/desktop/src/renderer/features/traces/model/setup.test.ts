import { expect, test } from "bun:test";
import type { TracesSnapshot } from "@polaris/protocol";
import { fixtureSnapshot } from "../preview/fixtureApi.ts";
import { FIXTURE_ENDPOINT } from "../preview/fixtures.ts";
import { setupState } from "./setup.ts";

const ready = (value: TracesSnapshot) => ({ status: "ready" as const, value });

const connected = { label: "Mac Studio", state: "connected" as const };

test("each receiver state has its setup state, and traces have none", () => {
  expect(setupState(ready(fixtureSnapshot("traces")), connected)).toBeNull();
  expect(setupState(ready(fixtureSnapshot("empty")), connected)).toEqual({
    kind: "empty",
    endpoint: FIXTURE_ENDPOINT,
  });
  expect(setupState(ready(fixtureSnapshot("userExported")), connected)).toEqual({
    kind: "userExported",
  });
  expect(setupState(ready(fixtureSnapshot("unavailable")), connected)).toEqual({
    kind: "unavailable",
    code: "E-TRACE-PORT-IN-USE",
    message: "127.0.0.1:4319 is in use by another process",
    owner: "otelcol-contrib (pid 4127)",
  });
});

test("a Host that isn't connected reads as reconnecting unless it already gave traces", () => {
  const away = { label: "lucas-rpi", state: "reconnecting" as const };

  expect(setupState({ status: "loading" }, away)).toEqual({
    kind: "reconnecting",
    host: "lucas-rpi",
  });
  expect(setupState(ready(fixtureSnapshot("empty")), away)).toEqual({
    kind: "reconnecting",
    host: "lucas-rpi",
  });
  expect(setupState(ready(fixtureSnapshot("traces")), away)).toBeNull();
});

test("on a connected Host a read in flight is loading and a failed one keeps its error", () => {
  const error = { code: "E-TRACE-NONE", message: "Nothing has reached the receiver", fix: "x" };

  expect(setupState({ status: "loading" }, connected)).toEqual({ kind: "loading" });
  expect(setupState({ status: "failed", error }, connected)).toEqual({ kind: "failed", error });
});
