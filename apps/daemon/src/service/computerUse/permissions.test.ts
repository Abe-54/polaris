import { expect, test } from "bun:test";
import { Option } from "effect";
import { permissionsOf } from "./permissions.ts";

/** agent-desktop 1.2.0's `status`, cut to what matters, with each permission in a given state. */
const status = (accessibility: string, screenRecording: string) =>
  JSON.stringify({
    version: "2.6",
    ok: true,
    command: "status",
    data: {
      permissions: {
        accessibility: {
          state: accessibility,
          suggestion: "Run agent-desktop permissions --guide.",
        },
        automation: { state: "unknown" },
        screen_recording: { state: screenRecording },
      },
      platform: "macos",
    },
  });

test.each([
  ["denied", "denied", "needs setup", ["accessibility", "screen recording"]],
  ["granted", "denied", "needs setup", ["screen recording"]],
  ["unknown", "granted", "needs setup", ["accessibility"]],
  ["granted", "granted", "ready", []],
  ["granted", "not_required", "ready", []],
] as const)("accessibility %s and screen recording %s is %s", (ax, screen, state, missing) => {
  expect(Option.getOrNull(permissionsOf(status(ax, screen)))).toEqual({ state, missing });
});

test("output that isn't a status is no answer, rather than ready", () => {
  expect(Option.isNone(permissionsOf("agent-desktop: command not found"))).toBe(true);
  expect(Option.isNone(permissionsOf(JSON.stringify({ ok: false, error: "boom" })))).toBe(true);
});
