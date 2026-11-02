import { expect, test } from "bun:test";
import { getShortestPaths, getAdjacencyMap, adjacencyMapToArray } from "xstate/graph";
import {
  constellationMachine,
  constellationTransition,
  type LifecycleInput,
} from "./constellation.ts";
import type { ConstellationState } from "@polaris/protocol";

const events: ReadonlyArray<LifecycleInput> = [
  { type: "Dispatch" },
  { type: "Pause" },
  { type: "Resume" },
  { type: "Complete" },
  { type: "Archive" },
  { type: "Mutate" },
  { type: "HandOver" },
];

const reference: Record<
  ConstellationState,
  Partial<Record<LifecycleInput["type"], ConstellationState>>
> = {
  planning: { Dispatch: "running", Resume: "running", Mutate: "planning", HandOver: "planning" },
  running: {
    Dispatch: "running",
    Pause: "paused",
    Complete: "completed",
    Mutate: "running",
    HandOver: "running",
  },
  paused: { Resume: "running", Complete: "completed", Mutate: "paused", HandOver: "paused" },
  completed: { Archive: "archived" },
  archived: {},
};

test("graph traversal reaches every lifecycle state and matches the reference transitions", () => {
  const options = { events: [...events] };
  const paths = getShortestPaths(constellationMachine, options);
  expect(new Set<string>(paths.map((path) => path.state.value))).toEqual(
    new Set(Object.keys(reference))
  );

  for (const state of Object.keys(reference)) {
    // SAFETY: reference is keyed by exactly the five ConstellationState values.
    const current = state as ConstellationState;

    for (const event of events)
      expect(constellationTransition(current, event)).toBe(reference[current][event.type] ?? null);
  }

  expect(
    adjacencyMapToArray(getAdjacencyMap(constellationMachine, options)).length
  ).toBeGreaterThan(5);
});
