import { describe, expect, test } from "bun:test";
import { FIXTURE_SCHEMA, FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { treeRows, type TreeLoad } from "./tree.ts";
import { type TreeMove, treeKey } from "./treeKeys.ts";

const trees = new Map<string, TreeLoad>([["app", { status: "ready", value: FIXTURE_SCHEMA }]]);

const rows = treeRows({ sources: FIXTURE_SOURCES, trees, changes: [], toggled: new Map() });

const at = (key: string) => rows.findIndex((r) => r.key === key);

/** Where a move lands, as the row's key, or what it toggles. */
const landed = (move: TreeMove | null) => {
  if (move === null) return null;

  return "focus" in move ? rows[move.focus]?.key : `toggle ${move.toggle.key}`;
};

const key = (from: string, name: string) => landed(treeKey(rows, at(from), name));

const SOURCE = "source\u0000app";

const SCHEMA = "schema\u0000app\u0000public";

const INVOICES = "table\u0000app\u0000public\u0000invoices";

const FUNCTIONS = "functions\u0000app\u0000public";

describe("the Sources tree's keys", () => {
  test("↓ and ↑ walk the rows in order, passing over a locked source's note", () => {
    const locked = FIXTURE_SOURCES.filter((s) => s.name === "analytics");
    const rest = FIXTURE_SOURCES.filter((s) => s.name !== "analytics");

    const order = treeRows({
      sources: [...locked, ...rest],
      trees,
      changes: [],
      toggled: new Map(),
    });

    const move = (from: number, name: string) => treeKey(order, from, name);

    expect(order.slice(0, 3).map((r) => r.kind)).toEqual(["source", "note", "source"]);
    expect([move(0, "ArrowDown"), move(2, "ArrowUp")]).toEqual([{ focus: 2 }, { focus: 0 }]);
    expect(key(SOURCE, "ArrowDown")).toBe(SCHEMA);
    expect(key(SCHEMA, "ArrowUp")).toBe(SOURCE);
  });

  test("→ opens a closed row and enters an open one; ← closes it, then goes to the parent", () => {
    expect([key(SOURCE, "ArrowRight"), key(SCHEMA, "ArrowLeft")]).toEqual([
      SCHEMA,
      `toggle ${SCHEMA}`,
    ]);
    expect([key(FUNCTIONS, "ArrowRight"), key(INVOICES, "ArrowLeft")]).toEqual([
      `toggle ${FUNCTIONS}`,
      SCHEMA,
    ]);
    expect(key(INVOICES, "ArrowRight")).toBeNull();
  });

  test("Home and End go to the first and last rows; other keys are left to the row", () => {
    expect([key(INVOICES, "Home"), key(INVOICES, "End"), key(INVOICES, "Enter")]).toEqual([
      SOURCE,
      "source\u0000analytics",
      null,
    ]);
  });
});
