import { describe, expect, test } from "bun:test";
import { applyCompletion, complete } from "./completion.ts";
import { keyFilter, tableSql } from "./sql.ts";

const COLUMNS = [
  { name: "status", type: "enum" },
  { name: "due_at", type: "timestamptz" },
  { name: "customer_id", type: "uuid" },
  { name: "paid_at", type: "timestamptz" },
];

describe("the Table tab's SQL", () => {
  test("a page orders by the key and quotes for the engine", () => {
    expect(
      tableSql({
        engine: "postgres",
        table: "invoices",
        filter: "WHERE status = 'overdue';",
        orderBy: ["id"],
        limit: 1000,
        offset: 2000,
      })
    ).toBe(
      `SELECT * FROM "invoices" WHERE status = 'overdue' ORDER BY "id" LIMIT 1000 OFFSET 2000`
    );
    expect(
      tableSql({
        engine: "mysql",
        table: "order`s",
        filter: " ",
        orderBy: [],
        limit: 200,
        offset: 0,
      })
    ).toBe("SELECT * FROM `order``s` LIMIT 200");
  });

  test("a foreign key's filter escapes the value", () => {
    expect(keyFilter("postgres", "name", "O'Brien")).toBe(`"name" = 'O''Brien'`);
  });
});

describe("filter completion", () => {
  test("columns that start with the word come before ones that contain it", () => {
    const at = complete("paid_at is null and _at", 23, COLUMNS);

    expect(at?.items.map((i) => i.label)).toEqual(["due_at", "paid_at"]);
    expect(at?.from).toBe(20);
  });

  test("keywords complete by prefix only, and nothing completes inside a string", () => {
    expect(complete("status = 'ov", 12, COLUMNS)).toBeNull();
    expect(complete("status is n", 11, COLUMNS)?.items.map((i) => i.label)).toEqual(["not"]);
  });

  test("accepting replaces the whole word under the caret", () => {
    const text = "cus = 1";
    const at = complete(text, 2, COLUMNS);

    if (at === null) throw new Error("no completion");
    expect(applyCompletion(text, at, "customer_id")).toEqual({
      text: "customer_id = 1",
      caret: 12,
    });
  });
});
