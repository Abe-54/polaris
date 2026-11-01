import { describe, expect, test } from "bun:test";
import { QueryLogEntry, RequestId, type SessionId } from "@polaris/protocol";
import {
  FIXTURE_PENDING_WRITE_ID,
  FIXTURE_QUERY_LOG,
  FIXTURE_SESSIONS,
} from "../preview/fixtures.ts";
import { WORST_QUERY_LOG } from "../preview/worstCase.ts";
import {
  authorText,
  busyTables,
  dataActivity,
  drawerKicker,
  mentionsTable,
  resultText,
  runsOnOpen,
  scopedRows,
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

  test("a query outside Polaris keeps the Turn it ran in", () => {
    const outside = FIXTURE_QUERY_LOG.filter((e) => e.id === "q-outside");

    const [row] = logRows(outside, {
      ...lookups,
      turn: (_id, turn) => (turn === "turn-4" ? 4 : null),
    });

    expect(row?.author.kind === "outside" ? row.author.turn : "not outside").toBe(4);
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
        turn: null,
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

describe("the drawer under the grid (Paper D1)", () => {
  const rows = scopedRows(FIXTURE_QUERY_LOG, lookups, null);
  const row = (id: string) => found(rows.find((r) => r.id === id));

  test("each row names who ran it: the session and its Turn, You, or the needs-you write", () => {
    expect(authorText(row(FIXTURE_PENDING_WRITE_ID))).toBe("Backfill currency · needs you");
    expect(authorText(row("q-branch-read"))).toBe("Fix overdue totals · turn 12");
    expect(authorText(row("q-user-1"))).toBe("You");
    expect(authorText(row("q-outside"))).toBe("Backfill currency · outside Polaris");
  });

  test("a Turn the feed can't number is left unnumbered", () => {
    const old = found(
      rows.find(
        (r) =>
          r.author.kind === "agent" &&
          r.entry.author.kind === "agent" &&
          r.entry.author.turn === "turn-4"
      )
    );

    expect(authorText(old)).toBe("Backfill currency");
  });

  test("a failure says failed and the pending write has no rows yet", () => {
    expect(resultText(row("q-failed"))).toBe("failed");
    expect(resultText(row(FIXTURE_PENDING_WRITE_ID))).toBe("—");
    expect(resultText(row("q-user-2"))).toBe("38 rows");
  });

  test("scoped to a table, only that source's queries naming it", () => {
    const invoices = scopedRows(FIXTURE_QUERY_LOG, lookups, { source: "app", table: "invoices" });

    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices.every((r) => r.source === "app")).toBe(true);
    expect(invoices.some((r) => r.sql.includes("invoice_items"))).toBe(false);
    expect(drawerKicker({ source: "app", table: "invoices" }, invoices.length)).toBe(
      `Query log · invoices · ${invoices.length}`
    );
  });
});

describe("table names", () => {
  test.each([
    ["select * from currencies where note = 'see invoices'", false],
    ["select * from currencies -- invoices next", false],
    ["select * from invoices", true],
    ['select * from "invoices" i', true],
    ["select * from public.invoices", true],
    ["select * from invoice_items", false],
    ["select * from old_invoices", false],
  ])("%s", (sql, named) => {
    expect(mentionsTable(sql, "invoices")).toBe(named);
  });
});

describe("only a lone plain SELECT that calls no function re-runs on open (F10)", () => {
  test.each([
    ["  select 1", true],
    ["select * from invoices;", true],
    ["select * from invoices where status = 'set' and id in (1, 2)", true],
    ["select id, comment from invoices -- delete later", true],
    ["select pg_terminate_backend(pid) from pg_stat_activity", false],
    ["select pg_sleep(3600)", false],
    ["select count(*) from invoices", false],
    ['select "lo_unlink"(1)', false],
    ["with t as (select 1) select * from t", false],
    ["explain select * from invoices", false],
    ["update invoices set currency = 'USD'", false],
    ["with gone as (delete from invoices returning *) select * from gone", false],
    ["explain analyze delete from invoices", false],
    ["select * into invoices_copy from invoices", false],
    ["select 1; drop table invoices", false],
    ["select * from invoices for update", false],
    ["select pg_sleep(1); select 1", false],
    // Where an engine may lex differently from the mask, it isn't run on open.
    ["select '\\' as a, pg_sleep(10) as b --'", false],
    ["select 1 /*! , sleep(10) */", false],
    ["select 1 /*+ max_execution_time(1) */ from invoices", false],
    ["select 1 # comment", false],
    ["select ';' as semicolon", false],
  ])("%s", (sql, runs) => {
    expect(runsOnOpen(sql)).toBe(runs);
  });
});

test("unknown write outcomes are distinct from failure and completion", () => {
  const [row] = logRows(
    [
      new QueryLogEntry({
        id: "unknown",
        checkout: "/repo",
        source: { id: "db", name: "db" },
        sql: "UPDATE items SET v=1",
        state: "unknown",
        author: { kind: "user" },
        at: "2026-10-30T00:00:00Z",
      }),
    ],
    lookups
  );

  expect(row!.state).toBe("unknown");
  expect(row!.result).toContain("check the rows before retrying");
  expect(resultText(row!)).toBe("outcome unknown");
});
