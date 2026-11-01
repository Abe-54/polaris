import { describe, expect, test } from "bun:test";
import { hostView } from "../../../routes/fixtures.testing.ts";
import { profilesUnavailable, tracesUnavailable } from "./availability.ts";

const host = (
  state: "connected" | "reconnecting",
  capabilities: ReadonlyArray<"traces" | "traces.profiles">
) => {
  const view = hostView("studio", state);

  return { ...view, label: "Mac Studio", status: { ...view.status, capabilities } };
};

describe("tracesUnavailable", () => {
  test("a connected Daemon without traces names the Host", () => {
    expect(tracesUnavailable(host("connected", []))).toBe(
      "Traces need a newer daemon on Mac Studio"
    );
  });

  test("a Host that hasn't said its capabilities yet, or has traces, isn't refused", () => {
    expect([
      tracesUnavailable(host("reconnecting", [])),
      tracesUnavailable(host("connected", ["traces"])),
      tracesUnavailable(undefined),
    ]).toEqual([null, null, null]);
  });
});

describe("profilesUnavailable", () => {
  test("a Daemon with traces but not traces.profiles can't list Profiles", () => {
    expect(profilesUnavailable(host("connected", ["traces"]))).toBe(
      "Profiles need a newer daemon on Mac Studio"
    );
    expect(profilesUnavailable(host("connected", ["traces", "traces.profiles"]))).toBeNull();
    expect(profilesUnavailable(host("reconnecting", []))).toBeNull();
  });
});
