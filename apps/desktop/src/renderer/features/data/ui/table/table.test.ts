import { describe, expect, test } from "bun:test";
import { DataValueTags } from "../../grid/value.ts";
import { applyCompletion, complete } from "./completion.ts";
import { filterProblem, keyFilter, quoteValue, tableSql } from "./sql.ts";

const { BigInt, Bytes, Numeric, Truncated } = DataValueTags.cases;

const COLUMNS = [
  { name: "status", type: "enum" },
  { name: "due_at", type: "timestamptz" },
  { name: "customer_id", type: "uuid" },
  { name: "paid_at", type: "timestamptz" },
];

const page = (filter: string, engine: "postgres" | "mysql" = "postgres") =>
  tableSql({
    engine,
    table: { schema: "public", name: "events" },
    filter,
    orderBy: ["id"],
    limit: 1000,
    offset: 1000,
  });

describe("the Table tab's SQL", () => {
  test("a page reads schema and table quoted apart, ordered by the key, for either engine", () => {
    expect(
      tableSql({
        engine: "postgres",
        table: { schema: "billing", name: "invoices" },
        filter: "WHERE status = 'overdue';",
        orderBy: ["id"],
        limit: 1000,
        offset: 2000,
      })
    ).toBe(
      `SELECT * FROM "billing"."invoices"\nWHERE (\nstatus = 'overdue'\n)\nORDER BY "id"\nLIMIT 1000\nOFFSET 2000`
    );
    expect(
      tableSql({
        engine: "mysql",
        table: { schema: "ledger", name: "order`s" },
        filter: " ",
        orderBy: [],
        limit: 200,
        offset: 0,
      })
    ).toBe("SELECT * FROM `ledger`.`order``s`\nLIMIT 200");
  });

  test("a -- comment or an OR in the filter can't reach ORDER BY, LIMIT or OFFSET", () => {
    const sql = page("kind = 'refund' -- refunds only");

    expect(sql.split("\n").slice(-3)).toEqual(['ORDER BY "id"', "LIMIT 1000", "OFFSET 1000"]);
    expect(page("a = 1 or b = 2")).toContain("WHERE (\na = 1 or b = 2\n)");
  });

  test.each([
    ["status = 'paid' /* only paid", "isn't closed"],
    ["note = 'it''s", "isn't closed"],
    ["true) or (1 = 1", "didn't open"],
    ["(status = 'paid'", "isn't closed"],
    ["false; commit; insert into events values (1)", "can't hold a ;"],
  ])("%p is refused: %p", (filter, problem) => {
    expect(filterProblem("postgres", filter)).toContain(problem);
  });

  test.each([
    ["status = 'a;b' and note = 'x)'"],
    ['"weird ) name" = 1'],
    ["kind = 'refund' -- one; (two"],
    ["body = $$ ) ; $$"],
    ["status = 'paid' /* a /* nested */ comment */"],
    ["note = E'it\\'s ) here'"],
  ])("%p stays one expression and runs", (filter) => {
    expect(filterProblem("postgres", filter)).toBeNull();
  });

  test("MySQL reads backslash escapes, backticks and # comments", () => {
    expect(filterProblem("mysql", "note = 'a\\') b' and `x)` = 1 # )")).toBeNull();
    expect(filterProblem("mysql", "a = 1 /* x /* y */ ) */")).toContain("didn't open");
  });

  test("a value literal never depends on MySQL's backslash mode", () => {
    expect(quoteValue("postgres", "O'Brien\\")).toBe("'O''Brien\\'");
    expect(quoteValue("mysql", "a\\b'")).toBe("CONCAT('a', LEFT('\\\\', 1), 'b''')");
    expect(quoteValue("mysql", "\\")).toBe("CONCAT(LEFT('\\\\', 1))");
  });
});

describe("following a foreign key", () => {
  test.each([
    [42, `id = 42`],
    [BigInt.make({ value: "-9223372036854775808" }), `id = -9223372036854775808`],
    [Numeric.make({ value: "NaN" }), `id = 'NaN'`],
    [true, `id = TRUE`],
    ["O'Brien", `id = 'O''Brien'`],
  ])("%p filters by its typed value", (value, filter) => {
    expect(keyFilter("postgres", "id", value)).toEqual({ filter });
  });

  test("the key column is quoted only where the engine needs it", () => {
    expect(keyFilter("postgres", "userId", 7)).toEqual({ filter: `"userId" = 7` });
    expect(keyFilter("mysql", "order", 7)).toEqual({ filter: "`order` = 7" });
  });

  test.each([
    [Bytes.make({ length: 2, preview: "\\x0102" }), "binary"],
    [Truncated.make({ preview: "abc", bytes: 99_999 }), "cut short"],
    ["two\nlines", "line break"],
    [null, "NULL"],
  ])("%p can't be followed, and says why", (value, reason) => {
    const followed = keyFilter("postgres", "id", value);

    expect("reason" in followed ? followed.reason : "").toContain(reason);
  });
});

describe("filter completion", () => {
  test("columns that start with the word come before ones that contain it", () => {
    const at = complete("paid_at is null and _at", 23, COLUMNS, "postgres");

    expect(at?.items.map((i) => i.label)).toEqual(["due_at", "paid_at"]);
    expect(at?.from).toBe(20);
  });

  test("keywords complete by prefix only, and nothing completes inside a string", () => {
    expect(complete("status = 'ov", 12, COLUMNS, "postgres")).toBeNull();
    expect(complete("status is n", 11, COLUMNS, "postgres")?.items.map((i) => i.label)).toEqual([
      "not",
    ]);
  });

  test("accepting replaces the whole word under the caret", () => {
    const text = "cus = 1";
    const at = complete(text, 2, COLUMNS, "postgres");
    const item = at?.items[0];

    if (at === null || item === undefined) throw new Error("no completion");
    expect(applyCompletion(text, at, item)).toEqual({ text: "customer_id = 1", caret: 12 });
  });

  test("a name the engine would misread goes in quoted, and keywords are the engine's own", () => {
    const columns = [
      { name: "createdAt", type: "timestamptz" },
      { name: "order total", type: "numeric" },
      { name: "order", type: "int4" },
    ];

    const inserted = (engine: "postgres" | "mysql", word: string) =>
      complete(word, word.length, columns, engine)?.items.map((i) => i.insert);

    expect(inserted("postgres", "cre")).toEqual(['"createdAt"']);
    expect(inserted("mysql", "cre")).toEqual(["createdAt"]);
    expect(inserted("mysql", "ord")).toEqual(["`order total`", "`order`"]);
    expect(inserted("postgres", "ili")).toEqual(["ilike"]);
    expect(inserted("mysql", "ili")).toBeUndefined();
  });
});
