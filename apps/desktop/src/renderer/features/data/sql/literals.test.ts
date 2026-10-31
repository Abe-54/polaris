import { describe, expect, test } from "bun:test";
import { maskLiterals } from "./literals.ts";

/** The SQL with each of `parts` replaced by as many spaces. */
const blank = (sql: string, ...parts: ReadonlyArray<string>) =>
  parts.reduce((text, part) => text.replace(part, " ".repeat(part.length)), sql);

describe("SQL with its literals and comments blanked", () => {
  test.each([
    ["select 'set' from t", ["'set'"]],
    ["select 'it''s' , x", ["'it''s'"]],
    ["select 1 -- delete\nfrom t", ["-- delete"]],
    ["select /* drop */ 1", ["/* drop */"]],
    ["select $$update$$, $q$x$q$", ["$$update$$", "$q$x$q$"]],
    ['select "it\'s" from t', []],
  ] as const)("%p", (sql, parts) => {
    expect(maskLiterals(sql)).toBe(blank(sql, ...parts));
  });
});
