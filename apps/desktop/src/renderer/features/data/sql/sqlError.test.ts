import { describe, expect, test } from "bun:test";
import { type DataIpcError, errorSpan } from "./sqlError.ts";

const marked = (sql: string, message: string, at: Partial<DataIpcError> = {}) => {
  const span = errorSpan(sql, { code: "E-DATA-SQL", message, ...at });

  return span === null
    ? null
    : { text: sql.slice(span.from, span.to), at: [span.line, span.column] };
};

describe("where a database error points", () => {
  test("the Host's position marks the token there", () => {
    expect(marked("select totl\nfrom invoices", "syntax error", { position: 8 })).toEqual({
      text: "totl",
      at: [1, 8],
    });
  });

  test("MySQL's near '…' text alone marks nothing: the Daemon's wrapper shifts it (F7)", () => {
    const sql = "select status\nfrom invoices\nwher status = 'x'";

    expect(
      marked(sql, "You have an error in your SQL syntax; ... near 'wher status = 'x'' at line 3")
    ).toBeNull();
  });

  test("the Host's line wins over a name the message quotes", () => {
    expect(
      marked("select id,\n  totl\nfrom t", 'column "totl" does not exist', { line: 2 })
    ).toEqual({ text: "totl", at: [2, 3] });
  });

  test("Postgres' quoted name, as a whole word and not inside another", () => {
    expect(
      marked("select total_cents, total from invoices", 'column "total" does not exist')
    ).toEqual({ text: "total", at: [1, 21] });
  });

  test("a quoted name inside a string literal or comment is skipped (F11)", () => {
    const sql = "select id from invoices where currency = 'totl' or totl > 1 -- totl";

    expect(marked(sql, 'column "totl" does not exist')).toEqual({ text: "totl", at: [1, 52] });
  });

  test("a name the query uses twice is not guessed at", () => {
    expect(marked("select totl, totl from t", 'column "totl" does not exist')).toBeNull();
  });

  test("an error that names nothing in the query has no position", () => {
    expect(marked("select 1", "canceling statement due to statement timeout")).toBeNull();
    expect(marked("select 1", 'relation "invoices" does not exist')).toBeNull();
  });

  test("MySQL's line alone marks that line's first token", () => {
    expect(marked("select 1\n  frm invoices", "syntax error", { line: 2 })).toEqual({
      text: "frm",
      at: [2, 3],
    });
  });

  test("a position past the query falls back to the message", () => {
    expect(
      marked("select total from t", 'column "total" does not exist', { position: 99 })
    ).toEqual({
      text: "total",
      at: [1, 8],
    });
  });
});
