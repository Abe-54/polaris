import { describe, expect, test } from "bun:test";
import { attempt, constellationOf, slugRecord, task } from "../preview/graph.ts";
import { largeRecord } from "../preview/large.ts";
import { attentionItems } from "./attention.ts";
import { plainFacts } from "./facts.ts";
import { railKey } from "./keys.ts";
import { RAIL, railCap, railStep, railX } from "./lane.ts";
import { deriveProjections } from "./project.ts";
import { buildRail, foldsAbove, parentFold, type ParentRow, type RailRow } from "./rail.ts";
import { segments } from "./strip.ts";
import type { TaskRow } from "./task.ts";

const facts = plainFacts();

const byId = (rows: ReadonlyArray<RailRow>, id: string) =>
  rows.find(
    (r): r is TaskRow | ParentRow => (r.kind === "task" || r.kind === "parent") && r.task.id === id
  );

const treeRows = (rows: ReadonlyArray<RailRow>) =>
  rows.flatMap((r) =>
    (r.kind === "task" || r.kind === "parent") && `${r.task.id}`.startsWith("F")
      ? [[r.kind, `${r.task.id}`, r.tree.depth, r.tree.last, [...r.tree.through]]]
      : []
  );

describe("parent projections", () => {
  test("a container rolls its children up and inherits its deps down", () => {
    const c = constellationOf({
      tasks: [
        task({ id: "D", title: "Dep" }),
        task({ id: "P", title: "Parent", deps: ["D"] }),
        task({ id: "P1", title: "Child", parent: "P" }),
        task({ id: "Q", title: "Done parent" }),
        task({ id: "Q1", title: "Done child", parent: "Q" }),
      ],
      attempts: [attempt({ taskId: "Q1", state: "accepted", minutes: 10 })],
    });

    const p = new Map(deriveProjections(c).map((x) => [`${x.taskId}`, x]));

    expect(p.get("P1")?.blockedBy.map(String)).toEqual(["D"]);
    expect(p.get("P1")?.state).toBe("waiting");
    expect(p.get("P")?.state).toBe("waiting");
    expect(p.get("P")?.children.map(String)).toEqual(["P1"]);
    expect(p.get("Q")?.state).toBe("done");
  });

  test("a blocked child keeps its parent working; the leaf reads blocked", () => {
    const p = new Map(slugRecord().projections.map((x) => [`${x.taskId}`, x.state]));

    expect([p.get("F"), p.get("F1"), p.get("F2"), p.get("F3")]).toEqual([
      "working",
      "working",
      "blocked",
      "blocked",
    ]);
  });
});

describe("the tree on the rail", () => {
  const rail = buildRail(slugRecord(), facts);

  test("group, then parents to any depth, a dependent under the sibling it waits on", () => {
    expect(treeRows(rail.rows)).toEqual([
      ["parent", "F", 1, true, []],
      ["parent", "F1", 2, false, []],
      ["task", "F1a", 3, true, [true]],
      ["task", "F1b", 4, true, [true, false]],
      ["task", "F2", 2, false, []],
      ["task", "F3", 2, true, []],
    ]);
  });

  test("a parent's tally counts its leaves, blocked included; its glyph is the rollup", () => {
    const f = byId(rail.rows, "F");

    expect(f).toMatchObject({ kind: "parent", open: true, total: 4, glyph: "review" });
    expect(f?.kind === "parent" ? f.tally : null).toMatchObject({
      blocked: 2,
      working: 1,
      done: 1,
    });
    expect(rail.tasks.some((r) => r.task.id === "F")).toBe(false);
    expect(rail.ids).toContain("F");
  });

  test("blocked rows say by what, or that they wait on the lead; blockers say what they block", () => {
    const f2 = byId(rail.rows, "F2");
    const f3 = byId(rail.rows, "F3");
    const f1b = byId(rail.rows, "F1b");

    expect(f2?.kind === "task" ? [f2.look.word, f2.look.glyph, f2.look.bucket] : null).toEqual([
      "blocked",
      "blocked",
      "blocked",
    ]);
    expect(f2?.kind === "task" ? f2.line : null).toEqual({
      kind: "blocked",
      on: [{ id: "F1b", tone: "neutral" }],
      reason: "Needs the signed feed URL to poll",
    });
    expect(f3?.kind === "task" ? f3.line : null).toMatchObject({ kind: "blocked", on: [] });
    expect(f1b?.kind === "task" ? f1b.blocks.map(String) : null).toEqual(["F2"]);
  });

  test("a blocked Task never reads stopped without claiming, nor needs you", () => {
    const silent = plainFacts({
      worker: (a) => ({ ...plainFacts().worker(a), stoppedWithoutClaiming: true }),
    });

    const rows = buildRail(slugRecord(), silent).rows;
    const f2 = byId(rows, "F2");

    expect(f2?.kind === "task" ? f2.look.attention : "missing").toBeNull();
    expect(
      attentionItems(buildRail(slugRecord(), silent).tasks, silent).map((i) => i.taskId)
    ).not.toContain("F2");
  });

  test("the strip counts blocked in its own tone", () => {
    const tones = segments(rail.tasks).flatMap((s) => (s.key.startsWith("F") ? [s.tone] : []));

    expect(tones).toEqual(["accepted", "working", "blocked", "blocked"]);
  });

  test("each strip segment names its Task and the state word its row shows", () => {
    const parts = segments(rail.tasks).filter((s) => s.key.startsWith("F"));

    expect(parts.map((s) => [s.key, s.word])).toEqual(
      rail.tasks.flatMap((r) => (r.task.id.startsWith("F") ? [[r.task.id, r.look.word]] : []))
    );
    expect(parts.every((s) => s.title !== "")).toBe(true);
  });

  test("folding a parent hides its subtree; ← and → fold and climb", () => {
    const folded = buildRail(slugRecord(), facts, {
      folds: new Map([[parentFold("F1"), false]]),
      filter: "all",
      query: "",
    });

    expect(treeRows(folded.rows).map(([, id]) => id)).toEqual(["F", "F1", "F2", "F3"]);
    expect(byId(folded.rows, "F")?.tree.down).toBe(true);
    expect(railKey("ArrowRight", folded.rows, "parent:F1")).toEqual({
      kind: "toggle",
      group: parentFold("F1"),
      open: true,
    });
    expect(railKey("ArrowLeft", rail.rows, "task:F1a")).toEqual({
      kind: "select",
      key: "parent:F1",
    });
    expect(railKey("ArrowLeft", rail.rows, "parent:F1")).toMatchObject({
      kind: "toggle",
      open: false,
    });
  });

  test("a jump opens the group and every parent above the Task", () => {
    expect(foldsAbove(slugRecord(), "F1b")).toEqual([
      "F · Updates",
      parentFold("F1"),
      parentFold("F"),
    ]);
  });

  test("a filter keeps the parents above a match", () => {
    const found = buildRail(slugRecord(), facts, {
      folds: new Map(),
      filter: "all",
      query: "serve",
    });

    expect(treeRows(found.rows).map(([, id]) => id)).toEqual(["F", "F1", "F1b"]);
  });

  test("large Constellations: a parent holding a block opens itself", () => {
    const large = buildRail(largeRecord(), facts);
    const u = large.rows.find((r) => r.kind === "parent" && r.task.id === "U");

    expect(u).toMatchObject({ open: true });
    expect(large.rows.some((r) => r.kind === "task" && r.task.id === "U2")).toBe(true);
  });
});

describe("rail geometry", () => {
  test("one step per view, fitted to its deepest row", () => {
    expect(railStep(0)).toBe(RAIL.maxStep);
    expect(railStep(1)).toBe(RAIL.maxStep);
    expect(railStep(3)).toBe(10);
    expect(railStep(9)).toBe(RAIL.minStep);
  });

  test("rows past the rail's reach stay on its last column", () => {
    const step = railStep(9);

    expect(railCap(step)).toBe(4);
    expect(railX(6, step)).toBe(railX(4, step));
    expect(railX(4, step) + 6).toBeLessThan(60 - 16);
  });
});
