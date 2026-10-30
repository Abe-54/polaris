import { describe, expect, test } from "bun:test";
import { FIXTURE_NOW, FIXTURE_SCHEMA } from "../preview/fixtures.ts";
import { resultsKicker, schemaLine, sqlErrorLines } from "./copy.ts";

const result = (returned: number, truncated: boolean, total?: number) => ({
  columns: [],
  rows: [],
  returned,
  total,
  truncated,
  elapsedMs: 9.4,
});

describe("the results kicker", () => {
  test.each([
    [result(5, false), "Results · 5 rows · 9 ms"],
    [result(1, false), "Results · 1 row · 9 ms"],
    [result(200, true, 1312), "Results · first 200 of 1,312 rows · 9 ms"],
    [result(200, true), "Results · first 200 rows · 9 ms"],
  ])("%#", (r, text) => {
    expect(resultsKicker(r)).toBe(text);
  });
});

describe("the run bar's schema line (Paper D2)", () => {
  test("loaded 4s ago with the fixture's seven tables", () => {
    expect(schemaLine(FIXTURE_SCHEMA, FIXTURE_NOW)).toBe("Schema loaded 4s ago · 7 tables");
  });

  test("minutes later, and a capped read says how many it left out", () => {
    const capped = {
      loadedAt: FIXTURE_SCHEMA.loadedAt,
      schemas: FIXTURE_SCHEMA.schemas,
      truncatedTables: 493,
    };

    expect(schemaLine(capped, FIXTURE_NOW + 5 * 60_000)).toBe(
      "Schema loaded 5m ago · 7 of 500 tables"
    );
  });
});

describe("a database error", () => {
  test("its message, where it points and the Host's fix", () => {
    const span = { from: 7, to: 12, line: 1, column: 8 };

    expect(
      sqlErrorLines(
        { code: "E-DATA-SQL", message: 'column "total" does not exist', fix: "Check the name" },
        span
      )
    ).toEqual({
      message: 'column "total" does not exist',
      where: "Line 1, column 8",
      fix: "Check the name",
    });
  });

  test("without a position or fix, only the message", () => {
    expect(sqlErrorLines({ code: "E-DATA-TIMEOUT", message: "Timed out" }, null)).toEqual({
      message: "Timed out",
      where: null,
      fix: null,
    });
  });
});
