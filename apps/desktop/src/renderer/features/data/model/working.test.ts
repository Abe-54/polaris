import { describe, expect, test } from "bun:test";
import { QueryLogEntry, SessionId, TurnId } from "@polaris/protocol";
import {
  FIXTURE_NOW,
  FIXTURE_QUERY_LOG,
  FIXTURE_SESSIONS,
  fixtureSessionLookup,
} from "../preview/fixtures.ts";
import { readerTitle, tableReader, type WorkingLookup } from "./working.ts";

const invoices = { source: "app", table: "invoices" };

const read = (
  sql: string,
  minutesAgo: number,
  turn = "turn-12",
  sessionId = FIXTURE_SESSIONS.overdue.id,
  state: QueryLogEntry["state"] = "running"
) =>
  new QueryLogEntry({
    id: `q-test-${minutesAgo}`,
    checkout: "/ledger",
    source: { id: "src-app", name: "app" },
    sql,
    author: { kind: "agent", sessionId, turn: TurnId.make(turn) },
    state,
    at: new Date(FIXTURE_NOW - minutesAgo * 60_000).toISOString(),
  });

describe("the Working strip over a table (DESIGN.md, Data)", () => {
  const title = (entries: ReadonlyArray<QueryLogEntry>) => {
    const reader = tableReader(entries, fixtureSessionLookup, invoices);

    return reader === null ? null : readerTitle(reader);
  };

  test("the Working session's current Turn querying invoices names it", () => {
    const entries = [...FIXTURE_QUERY_LOG, read("select * from invoices", 0)];

    expect(title(entries)).toBe("Fix overdue totals is reading this table");
    expect(tableReader(entries, fixtureSessionLookup, invoices)?.turn).toBe(12);
  });

  test("a finished query leaves no strip, though the session still works (F8)", () => {
    expect(title(FIXTURE_QUERY_LOG)).toBeNull();
    expect(
      title([read("select * from invoices", 40, "turn-12", undefined, "completed")])
    ).toBeNull();
  });

  test.each([
    ["select * from invoices where status = 'set'", "running", "is reading"],
    ["select id, comment from invoices", "running", "is reading"],
    ["update invoices set status = 'paid'", "running", "is changing"],
    ["with x as (delete from invoices returning id) select * from x", "running", "is changing"],
    ["update invoices set status = 'paid'", "waiting-approval", "wants to change"],
  ] as const)("%p %s: the strip says %s (F8)", (sql, state, verb) => {
    expect(title([read(sql, 0, "turn-12", undefined, state)])).toBe(
      `Fix overdue totals ${verb} this table`
    );
  });

  test("a table named only in a string literal doesn't count (F8)", () => {
    expect(title([read("select * from currencies where note = 'invoices'", 0)])).toBeNull();
  });

  test("a session that isn't Working leaves no strip", () => {
    const idle: WorkingLookup = (id) => {
      const facts = fixtureSessionLookup(id);

      return facts === null ? null : { ...facts, working: false };
    };

    expect(tableReader(FIXTURE_QUERY_LOG, idle, invoices)).toBeNull();
  });

  test("a query from an earlier Turn doesn't count", () => {
    expect(
      tableReader([read("select * from invoices", 1, "turn-3")], fixtureSessionLookup, invoices)
    ).toBeNull();
  });

  test("another table, or the same table on another source, doesn't count", () => {
    const entries = [read("select * from invoice_items", 1)];

    expect(tableReader(entries, fixtureSessionLookup, invoices)).toBeNull();
    expect(
      tableReader([read("select * from invoices", 1)], fixtureSessionLookup, {
        source: "ledger",
        table: "invoices",
      })
    ).toBeNull();
  });

  test("its newest query here decides reading or changing", () => {
    const entries = [
      read("update invoices set status = 'overdue'", 1),
      read("select * from invoices", 2),
    ];

    const reader = tableReader(entries, fixtureSessionLookup, invoices);

    expect(reader === null ? null : readerTitle(reader)).toBe(
      "Fix overdue totals is changing this table"
    );
  });

  test("an unknown session is skipped", () => {
    const stranger = read("select * from invoices", 0, "turn-12", SessionId.make("s-gone"));

    expect(tableReader([stranger], fixtureSessionLookup, invoices)).toBeNull();
  });
});
