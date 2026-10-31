import { describe, expect, test } from "bun:test";
import {
  FIXTURE_NOW,
  FIXTURE_QUERY_LOG,
  fixtureSessionLookup as lookup,
} from "../preview/fixtures.ts";
import {
  ageText,
  authorText,
  drawerKicker,
  logRows,
  mentionsTable,
  rowsText,
  runsOnOpen,
} from "./queryLog.ts";

const rows = (scope: Parameters<typeof logRows>[2] = null) =>
  logRows(FIXTURE_QUERY_LOG, lookup, scope);

describe("the Query Log drawer's rows (Paper D1)", () => {
  test("newest first: the pending write is the needs-you row", () => {
    const [first] = rows();

    expect(first?.status).toBe("needs-you");
    expect(first === undefined ? "" : authorText(first)).toBe("Backfill currency · needs you");
  });

  test("an agent's read names its session and Turn; yours says You", () => {
    const all = rows();
    const branch = all.find((r) => r.entry.id === "q-branch-read");
    const mine = all.find((r) => r.entry.id === "q-user-1");

    expect(branch === undefined ? "" : authorText(branch)).toBe("Fix overdue totals · turn 12");
    expect(mine === undefined ? "" : authorText(mine)).toBe("You");
  });

  test("a Turn other than the session's current one is left unnumbered", () => {
    const old = rows().find(
      (r) => r.who.kind === "agent" && r.who.title === "Backfill currency" && r.status === "done"
    );

    expect(old === undefined ? "" : authorText(old)).toBe("Backfill currency");
  });

  test("a psql call outside Polaris shows its command", () => {
    const outside = rows().find((r) => r.entry.id === "q-outside");

    expect(outside === undefined ? "" : authorText(outside)).toBe(
      "Backfill currency · outside Polaris"
    );
    expect(outside?.text).toStartWith("psql $DATABASE_URL -c");
  });

  test("scoped to a table, only that source's queries naming it", () => {
    const invoices = rows({ source: "app", table: "invoices" });

    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices.every((r) => r.entry.source.name === "app")).toBe(true);
    expect(invoices.some((r) => r.text.includes("invoice_items"))).toBe(false);
    expect(drawerKicker({ source: "app", table: "invoices" }, invoices.length)).toBe(
      `Query log · invoices · ${invoices.length}`
    );
  });

  test("rows, failures and ages read as the drawer prints them", () => {
    const failed = rows().find((r) => r.entry.id === "q-failed");
    const pending = rows()[0];

    expect(failed === undefined ? "" : rowsText(failed)).toBe("failed");
    expect(pending === undefined ? "" : rowsText(pending)).toBe("—");
    expect(ageText(new Date(FIXTURE_NOW - 8 * 60_000).toISOString(), FIXTURE_NOW)).toBe("8m");
    expect(ageText(new Date(FIXTURE_NOW - 20_000).toISOString(), FIXTURE_NOW)).toBe("now");
    expect(ageText(new Date(FIXTURE_NOW - 3 * 3_600_000).toISOString(), FIXTURE_NOW)).toBe("3h");
  });
});

describe("table names", () => {
  test.each([
    ["select * from invoices", true],
    ['select * from "invoices" i', true],
    ["select * from public.invoices", true],
    ["select * from invoice_items", false],
    ["select * from old_invoices", false],
  ])("%s", (sql, named) => {
    expect(mentionsTable(sql, "invoices")).toBe(named);
  });
});

test("reads re-run on open; writes wait in their tab", () => {
  expect(runsOnOpen("  select 1")).toBe(true);
  expect(runsOnOpen("with t as (select 1) select * from t")).toBe(true);
  expect(runsOnOpen("update invoices set currency = 'USD'")).toBe(false);
});
