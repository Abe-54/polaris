import { expect, test } from "bun:test";
import { type DataValue, DataValueTags } from "../../../grid/value.ts";
import { countStaged, keyIndex, noStaged, overlay, stage, stagedLabel, undo } from "./staged.ts";

const edit = (id: number, column: string, before: DataValue, value: DataValue) => ({
  key: [id],
  column,
  before,
  value,
});

test("the footer counts changes and rows, each with its own plural", () => {
  const one = stage(noStaged, edit(1, "status", "open", "paid"));

  expect(stagedLabel(countStaged(one))).toBe("1 change staged · 1 row");

  const three = stage(
    stage(one, edit(1, "currency", "USD", "EUR")),
    edit(2, "status", "open", "void")
  );

  expect(stagedLabel(countStaged(three))).toBe("3 changes staged · 2 rows");
});

test("typing a cell back to what it was unstages it, keeping the first value as before", () => {
  const once = stage(noStaged, edit(1, "status", "open", "paid"));
  // The second edit's `before` is what the grid showed (the staged value); the original stays.
  const twice = stage(once, edit(1, "status", "paid", "void"));

  expect([...twice.cells.values()][0]).toMatchObject({ before: "open", value: "void" });
  expect(stage(twice, edit(1, "status", "void", "open")).cells.size).toBe(0);
});

test("⌘Z takes back edits newest first, restoring the cell's earlier staged value", () => {
  const staged = stage(
    stage(stage(noStaged, edit(1, "status", "open", "paid")), edit(1, "status", "paid", "void")),
    edit(2, "status", "open", "paid")
  );

  const once = undo(staged);

  expect(countStaged(once)).toEqual({ changes: 1, rows: 1 });

  const twice = undo(once);

  expect([...twice.cells.values()].map((c) => c.value)).toEqual(["paid"]);
  expect(undo(undo(twice)).cells.size).toBe(0);
});

test("staged values lay over the rows they key, wherever paging or a filter put them", () => {
  const rows = [
    [10, "open"],
    [20, "open"],
    [30, "open"],
  ];

  const staged = stage(noStaged, edit(30, "status", "open", null));
  const written = [{ key: [20], column: "status", before: "open", value: "paid" }];

  const shown = overlay(rows, ["id", "status"], keyIndex(rows, [0]), {
    written,
    staged: staged.cells.values(),
  });

  expect(shown.rows).toEqual([
    [10, "open"],
    [20, "paid"],
    [30, null],
  ]);
  expect(shown.rows[0]).toBe(rows[0]);
  expect([...shown.staged.entries()].map(([row, cols]) => [row, [...cols]])).toEqual([[2, [1]]]);
});

test("a tagged key matches its row by value", () => {
  const key = DataValueTags.cases.BigInt.make({ value: "9007199254740993" });
  const rows = [[key, "a"]];
  const staged = stage(noStaged, { key: [key], column: "name", before: "a", value: "b" });

  expect(
    overlay(rows, ["id", "name"], keyIndex(rows, [0]), {
      written: [],
      staged: staged.cells.values(),
    }).rows
  ).toEqual([[key, "b"]]);
});
