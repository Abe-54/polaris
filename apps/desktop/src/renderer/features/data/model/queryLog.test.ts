import { describe, expect, test } from "bun:test";
import { QueryLogEntry, RequestId, type SessionId } from "@polaris/protocol";
import {
  FIXTURE_PENDING_WRITE_ID,
  FIXTURE_QUERY_LOG,
  FIXTURE_SESSIONS,
} from "../preview/fixtures.ts";
import { WORST_QUERY_LOG } from "../preview/worstCase.ts";
import {
  busyTables,
  dataActivity,
  type LogLookups,
  logRows,
  type SessionFacts,
  tableOf,
} from "./queryLog.ts";

/** The fixture a test names, or a failure saying it's gone. */
const found = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("No such fixture entry");

  return value;
};

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  title: "Fix overdue totals",
  harness: "claude",
  needsYou: false,
  working: true,
  ...over,
});

/** Backfill currency needs you; Fix overdue totals is working, in its Turn 12. */
const lookups: LogLookups = {
  session: (id: SessionId) =>
    id === FIXTURE_SESSIONS.backfill.id
      ? facts({ title: "Backfill currency", harness: "codex", needsYou: true, working: false })
      : facts(),
  turn: (_id, turn) => (turn === "turn-12" ? 12 : null),
};

test.each([
  ["select * from invoices where id = $1", "invoices"],
  ['SELECT "id" FROM "public"."invoice_items"', "invoice_items"],
  ["update invoices set currency = 'USD'", "invoices"],
  ["insert into `ledger`.`payments` values (1)", "payments"],
  ["select 1", null],
] as const)("%p names table %p", (sql, table) => {
  expect(tableOf(sql)).toBe(table);
});

describe("the Query log's rows", () => {
  const rows = logRows(FIXTURE_QUERY_LOG, lookups);

  test("the write waiting on its session leads as the needs-you row; the rest are newest first", () => {
    const times = rows.slice(1).map((row) => Date.parse(row.entry.at));

    expect(rows[0]?.id).toBe(FIXTURE_PENDING_WRITE_ID);
    expect(rows[0]?.state).toBe("needs-you");
    expect(times).toEqual(times.toSorted((a, b) => b - a));
  });

  test.each([
    ["pending", "needs-you"],
    ["approved", "running"],
  ] as const)("a running write whose approval is %s reads as %s", (status, state) => {
    const { id, checkout, source, sql, author, at } = found(
      FIXTURE_QUERY_LOG.find((e) => e.id === FIXTURE_PENDING_WRITE_ID)
    );

    const entry = new QueryLogEntry({
      id,
      checkout,
      source,
      sql,
      author,
      at,
      state: "running",
      approval: { id: RequestId.make("r-write"), status },
    });

    expect(logRows([entry], lookups)[0]?.state).toBe(state);
  });

  test("each author reads as the Query log shows it", () => {
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect([
      byId.get("q-failed")?.state,
      byId.get("q-failed")?.result,
      byId.get("q-user-1")?.author.kind,
      byId.get("q-user-1")?.result,
      byId.get("q-outside")?.author,
      byId.get("q-branch-read")?.author,
    ]).toEqual([
      "failed",
      'column "total" does not exist',
      "user",
      "214 rows",
      {
        kind: "outside",
        title: "Backfill currency",
        harness: "codex",
        command: `psql $DATABASE_URL -c "select count(*) from invoices where currency is null"`,
      },
      {
        kind: "agent",
        sessionId: FIXTURE_SESSIONS.overdue.id,
        title: "Fix overdue totals",
        harness: "claude",
        turn: 12,
      },
    ]);
  });
});

describe("what each agent is doing to data", () => {
  test("a session whose write waits on you wants to write", () => {
    expect(
      dataActivity(
        FIXTURE_SESSIONS.backfill.id,
        FIXTURE_QUERY_LOG,
        facts({ needsYou: true, working: false })
      )
    ).toBe("Wants to write");
  });

  test("a working session is querying the table of its unfinished or latest Query", () => {
    expect(dataActivity(FIXTURE_SESSIONS.overdue.id, WORST_QUERY_LOG, facts())).toBe(
      "Querying invoices"
    );
  });

  test("an idle session with only finished Queries is doing nothing to data", () => {
    expect(
      dataActivity(FIXTURE_SESSIONS.overdue.id, FIXTURE_QUERY_LOG, facts({ working: false }))
    ).toBeNull();
  });

  test("the tree's dither marks only tables a working agent is still reading", () => {
    expect([...busyTables(WORST_QUERY_LOG, lookups)]).toEqual([["app\u0000invoices", "claude"]]);
    expect(
      busyTables(WORST_QUERY_LOG, { ...lookups, session: () => facts({ working: false }) }).size
    ).toBe(0);
  });
});
