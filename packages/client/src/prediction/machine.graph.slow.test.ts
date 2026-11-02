import { expect, test } from "bun:test";
import { getShortestPaths } from "xstate/graph";
import { type PlacementSnapshot, placementMachine } from "./machine.ts";
import { target } from "./fixtures.testing.ts";

const events = [
  { type: "probe" },
  { type: "off" },
  { type: "probed", candidates: [] },
  { type: "probed", candidates: [target("client"), target("host")] },
  { type: "failed" },
  { type: "fallback" },
] as const;

test("Generated paths cover every placement state and preserve serving invariants", () => {
  const paths = getShortestPaths(placementMachine, {
    events,
    serializeState: (snapshot: PlacementSnapshot) =>
      JSON.stringify([
        snapshot.value,
        snapshot.context.serving?.side,
        snapshot.context.failedSides,
      ]),
  });

  expect(new Set(paths.map((path) => path.state.value))).toEqual(
    new Set(["probing", "serving", "degraded", "off"])
  );

  for (const { state } of paths.flatMap((path) => path.steps)) {
    expect(state.context.serving !== null).toBe(state.value === "serving");

    if (state.context.serving)
      expect(state.context.failedSides).not.toContain(state.context.serving.side);
  }
});
