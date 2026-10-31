import { describe, expect, test } from "bun:test";
import { QueryLogEntry, SessionId, TurnId } from "@polaris/protocol";
import {
  FIXTURE_NOW,
  FIXTURE_QUERY_LOG,
  FIXTURE_SESSIONS,
  fixtureSessionLookup,
} from "../preview/fixtures.ts";
import type { SessionLookup } from "./queryLog.ts";
import { readerTitle, tableReader } from "./working.ts";

const invoices = { source: "app", table: "invoices" };

const read = (
  sql: string,
  minutesAgo: number,
  turn = "turn-12",
  sessionId = FIXTURE_SESSIONS.overdue.id
) =>
  new QueryLogEntry({
    id: `q-test-${minutesAgo}`,
    checkout: "/ledger",
    source: { id: "src-app", name: "app" },
    sql,
    author: { kind: "agent", sessionId, turn: TurnId.make(turn) },
    state: "completed",
    at: new Date(FIXTURE_NOW - minutesAgo * 60_000).toISOString(),
  });

describe("the Working strip over a table (DESIGN.md, Data)", () => {
  test("the Working session's current Turn querying invoices names it", () => {
    const reader = tableReader(FIXTURE_QUERY_LOG, fixtureSessionLookup, invoices);

    expect(reader === null ? null : readerTitle(reader)).toBe(
      "Fix overdue totals is reading this table"
    );
    expect(reader?.turn).toBe(12);
  });

  test("a session that isn't Working leaves no strip", () => {
    const idle: SessionLookup = (id) => {
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
