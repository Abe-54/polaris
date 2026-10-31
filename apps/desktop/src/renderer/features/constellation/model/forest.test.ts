import { describe, expect, test } from "bun:test";
import { attempt, constellationOf, task } from "../preview/graph.ts";
import { plainFacts } from "./facts.ts";
import { startedRecord } from "./fold.ts";
import { arrange, flatten } from "./forest.ts";
import { railKey } from "./keys.ts";
import { buildRail, type RailRow } from "./rail.ts";

const DATA = "Data";

const record = () =>
  startedRecord(
    constellationOf({
      tasks: [
        task({ id: "C", title: "Contracts", group: DATA }),
        task({ id: "RC", title: "Review C", group: DATA, deps: ["C"] }),
        task({ id: "CF", title: "Fix C", group: DATA, deps: ["RC"] }),
        task({ id: "X", title: "Execution", group: DATA }),
        task({ id: "M", title: "MCP tools", group: DATA }),
        task({ id: "RM", title: "Review M", group: DATA, deps: ["M"] }),
        task({ id: "MX", title: "Integrate", group: DATA, deps: ["M", "X", "CF", "RM"] }),
        task({ id: "G", title: "Merged", group: DATA, kind: "gate", deps: ["CF", "MX"] }),
        task({ id: "Y", title: "Elsewhere", group: "Other" }),
        task({ id: "Z", title: "Needs Y", group: DATA, deps: ["Y"] }),
      ],
      attempts: [
        attempt({ taskId: "C", state: "accepted", minutes: 30 }),
        attempt({ taskId: "M", state: "accepted", minutes: 30 }),
      ],
    }),
    1
  );

const facts = plainFacts();

const depths = (rows: ReadonlyArray<RailRow>) =>
  rows.flatMap((r) => (r.kind === "task" ? [[`${r.task.id}`, r.tree.depth]] : []));

const also = (rows: ReadonlyArray<RailRow>, id: string) =>
  rows.flatMap((r) => (r.kind === "task" && r.task.id === id ? [r.also] : []))[0];

describe("dependents hang under the sibling they wait on", () => {
  const rows = buildRail(record(), facts).rows;

  test("chains step right; a Gate and a Task waiting outside its siblings stay at the top", () => {
    expect(depths(rows)).toEqual([
      ["C", 1],
      ["RC", 2],
      ["CF", 3],
      ["X", 1],
      ["M", 1],
      ["RM", 2],
      ["MX", 3],
      ["G", 1],
      ["Z", 1],
      ["Y", 1],
    ]);
  });

  test("other deps read ← in their state's tone; the one it hangs under and a Gate's don't", () => {
    expect(also(rows, "MX")).toEqual([
      { id: "M", tone: "accepted" },
      { id: "X", tone: "neutral" },
      { id: "CF", tone: "neutral" },
    ]);
    expect(also(rows, "RC")).toEqual([]);
    expect(also(rows, "G")).toEqual([]);
    expect(also(rows, "Z")).toEqual([{ id: "Y", tone: "neutral" }]);
  });

  test("← climbs from a dependent to the row it hangs under", () => {
    expect(railKey("ArrowLeft", rows, "task:MX")).toEqual({ kind: "select", key: "task:RM" });
  });

  test("a filter lists its matches flat", () => {
    const done = buildRail(record(), facts, { folds: new Map(), filter: "done", query: "" });

    expect(depths(done.rows)).toEqual([
      ["C", 1],
      ["M", 1],
    ]);
  });
});

describe("arrange", () => {
  const sib = (id: string, deps: ReadonlyArray<string> = []) => ({
    id,
    deps,
    nests: true,
    hosts: true,
  });

  test("a cycle can't strand a Task: each appears once, after the roots", () => {
    const placed = arrange([sib("A", ["B"]), sib("B", ["A"]), sib("C")], (s) => s);

    expect(placed.flatMap(flatten).map((s) => s.id)).toEqual(["C", "A", "B"]);
  });
});
