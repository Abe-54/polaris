import { expect, test } from "bun:test";
import { guardSql } from "./guard.ts";
import { mysqlMatrix } from "./guard.matrix.ts";

for (const [sql, sqlMode, allowed] of mysqlMatrix) {
  test(`MySQL recorded guard: ${sql}`, () => {
    const run = () => guardSql(sql, { engine: "mysql", sqlMode });

    if (allowed) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ code: "E-DATA-READ-ONLY" }));
  });
}

for (const sql of [
  "SELECT 1; COMMIT; UPDATE probe SET v=1",
  "SELECT 1;;",
  "SELECT 'unclosed",
  "/* unclosed",
  "SELECT $tag$unclosed",
])
  test(`Postgres rejects ${sql}`, () => {
    expect(() => guardSql(sql, { engine: "postgres" })).toThrow();
  });

for (const sql of [
  "SELECT ';' AS value; /* tail */",
  "SELECT $$; COMMIT; UPDATE probe$$;",
  "SELECT $tag$;$tag$; -- tail",
  "SELECT E'escaped\\\'; still quoted';",
  "SELECT 1 /* outer /* nested ; */ done */;",
])
  test(`Postgres accepts quoted semicolon: ${sql}`, () => {
    expect(() => guardSql(sql, { engine: "postgres" })).not.toThrow();
  });

test("MySQL refuses ambiguous input when sql_mode cannot be read", () => {
  for (const sql of [String.raw`SELECT '\\'`, 'SELECT "x"'])
    expect(() => guardSql(sql, { engine: "mysql", sqlMode: null })).toThrow();
  expect(guardSql("SELECT 1", { engine: "mysql", sqlMode: null }).keyword).toBe("SELECT");
});

test("MySQL ANSI_QUOTES identifiers do not have backslash escapes", () => {
  expect(() =>
    guardSql(String.raw`SELECT 1 AS "x\"; DROP TABLE probe; -- "`, {
      engine: "mysql",
      sqlMode: "ANSI_QUOTES",
    })
  ).toThrow();
});

test("Postgres standard_conforming_strings changes quote termination", () => {
  const sql = String.raw`SELECT '\'; SELECT 2 -- '`;
  expect(() => guardSql(sql, { engine: "postgres", standardConformingStrings: true })).toThrow();
  expect(() =>
    guardSql(sql, { engine: "postgres", standardConformingStrings: false })
  ).not.toThrow();
});

test("only a terminator outside literals is removed for nesting", () => {
  expect(guardSql("SELECT ';'; -- tail", { engine: "postgres" }).sql).toBe("SELECT ';'");
});
