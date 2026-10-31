import { describe, expect, test } from "bun:test";
import { DataSource, RequestId } from "@polaris/protocol";
import { Schema } from "effect";
import { Decisions } from "../../../commands.ts";
import { FIXTURE_SOURCES } from "../preview/fixtures.ts";
import {
  fixtureWrite,
  fixtureWriteEntry,
  insertWrite,
  notPreviewedWrite,
  PREVIEW_NOTE,
  withParams,
} from "../preview/writeFixtures.ts";
import {
  cellChanges,
  denyDecision,
  dryRunKicker,
  noteLine,
  paramsLine,
  runLabel,
  settledLine,
  showingLine,
  topBarColour,
  verbOf,
  writeWants,
  type WriteVerb,
} from "./model.ts";
import { sqlTokens } from "./sqlTokens.ts";

const fields = Schema.encodeSync(DataSource);

describe("the verb follows the statement", () => {
  test.each<[string, WriteVerb]>([
    ["update invoices set currency = 'USD'", "update"],
    ["  INSERT INTO currencies VALUES ('CHF', 2)", "insert"],
    ["replace into currencies values ('CHF', 2)", "insert"],
    ["delete from sessions where expires_at < now()", "delete"],
    ["-- delete nothing\nupdate t set a = 1", "update"],
    ["update t set note = 'delete me'", "update"],
    [
      "with stale as (select id from invoices where x in (select 1)) delete from invoices using stale",
      "delete",
    ],
    ["alter table invoices add column currency text", "schema change"],
    ["merge into t using s on t.id = s.id when matched then update set a = 1", "write"],
  ])("%s → %s", (sql, verb) => {
    expect(verbOf(sql)).toBe(verb);
  });
});

describe("the counts come from affected", () => {
  test("Run and the kicker say the rows the dry run changed", () => {
    const write = fixtureWrite();

    expect(runLabel(write)).toBe("Run 214-row update");
    expect(dryRunKicker(write)).toBe("Dry run · rolled back · 214 rows");
    expect(showingLine(write)).toBe("showing 20 of 214");
  });

  test("one row is singular and a large count is grouped", () => {
    expect(dryRunKicker(fixtureWrite({ affected: 1, before: [], after: [] }))).toBe(
      "Dry run · rolled back · 1 row"
    );
    expect(runLabel(fixtureWrite({ affected: 1_204_118, sql: "delete from t" }))).toBe(
      "Run 1,204,118-row delete"
    );
  });

  test("an insert counts new rows, all added, with nothing before", () => {
    const write = insertWrite();

    expect(dryRunKicker(write)).toBe("Dry run · rolled back · 3 new rows");
    expect(runLabel(write)).toBe("Run 3-row insert");
    expect(showingLine(write)).toBeNull();
    expect(cellChanges(write).flat()).toEqual(Array.from({ length: 9 }, () => "added" as const));
  });

  test("a schema change runs without a row count", () => {
    const write = fixtureWrite({ sql: "create index on invoices (currency)", affected: 0 });

    expect(runLabel(write)).toBe("Run schema change");
    expect(dryRunKicker(write)).toBe("Dry run · rolled back");
  });

  test.each([
    ["this table has triggers", "update payments set settled = true where invoice_id = $1"],
    ["this statement changes the schema", "alter table payments add column note text"],
  ])("a write the Daemon didn't preview says why in its words: %s", (reason, sql) => {
    const write = notPreviewedWrite(`Not previewed: ${reason}`, sql);

    expect(dryRunKicker(write)).toBe(`Not previewed: ${reason}`);
    expect(runLabel(write)).toBe("Run without preview");
    expect(showingLine(write)).toBeNull();
    expect(noteLine(write)).toBeNull();
  });

  test("an unpreviewed update asks to run without preview", () => {
    expect(writeWants(notPreviewedWrite())).toBe("wants to run an update without preview on app");
  });

  test("a previewed write's note is the caption, sequences included", () => {
    expect(noteLine(insertWrite())).toBe(PREVIEW_NOTE);
    expect(noteLine(fixtureWrite())).toBeNull();
  });

  test("bound params read under the SQL as $n = value, NULL included", () => {
    expect(paramsLine(withParams(fixtureWrite(), ["inv_04810", 42, null]))).toEqual([
      "$1 = inv_04810",
      "$2 = 42",
      "$3 = NULL",
    ]);
    expect(paramsLine(fixtureWrite())).toEqual([]);
  });

  test("the ask takes the right article", () => {
    expect(writeWants(fixtureWrite())).toBe("wants to run a 214-row update on app");
    expect(writeWants(fixtureWrite({ affected: 8 }))).toBe("wants to run an 8-row update on app");
    expect(writeWants(fixtureWrite({ affected: 11 }))).toBe("wants to run an 11-row update on app");
    expect(writeWants(fixtureWrite({ affected: 118 }))).toBe(
      "wants to run a 118-row update on app"
    );
  });
});

test("an update's changed cells are the ones whose value differs", () => {
  const write = fixtureWrite({
    columns: ["id", "currency", "total"],
    before: [["a", null, 1]],
    after: [["a", "USD", 1]],
    affected: 1,
  });

  expect(cellChanges(write)).toEqual([["same", "changed", "same"]]);
});

test("a delete's rows are all removed", () => {
  const write = fixtureWrite({ sql: "delete from t", columns: ["id"], before: [["a"]], after: [] });

  expect(cellChanges(write)).toEqual([["removed"]]);
});

describe("the remote top bar takes the label colour", () => {
  const [app, branch, analytics] = FIXTURE_SOURCES;

  test("a local source has none, a remote one its label's", () => {
    expect(topBarColour(app)).toBeNull();
    expect(topBarColour(branch)).toBe("tan");
    expect(topBarColour(analytics)).toBe("red");
  });

  test("a remote source the user left uncoloured has none; an unlisted one none", () => {
    const plain = new DataSource({ ...fields(analytics!), label: { text: "", colour: "none" } });

    expect(topBarColour(plain)).toBeNull();
    expect(topBarColour(undefined)).toBeNull();
  });
});

describe("an answered card collapses to one line", () => {
  const write = fixtureWrite();
  const allowed = { kind: "allowed" } as const;

  test.each([
    [
      "ran, with the rows the database reported",
      fixtureWriteEntry(write, "completed", { rows: 212 }),
      "Ran 212-row update",
    ],
    ["running", fixtureWriteEntry(write, "running"), "Running 214-row update…"],
    ["not yet logged", undefined, "Allowed 214-row update"],
    [
      "answered, the agent not retried yet",
      fixtureWriteEntry(write, "cancelled", {
        approval: { id: RequestId.make("r"), status: "approved" },
      }),
      "Allowed 214-row update",
    ],
    ["interrupted", fixtureWriteEntry(write, "cancelled"), "Cancelled 214-row update"],
  ])("%s", (_name, entry, line) => {
    expect(settledLine(write, allowed, entry).line).toBe(line);
  });

  test("an unconfirmed run blames no cause and promises no rerun the Daemon refuses (F5)", () => {
    expect(settledLine(write, allowed, fixtureWriteEntry(write, "unknown"))).toEqual({
      kind: "unknown",
      line: "214-row update: outcome unknown",
      detail:
        "Polaris lost track of this write before the database confirmed it. Check the rows before asking the agent to try again.",
    });
  });

  test("a failed run keeps the database's words", () => {
    const entry = fixtureWriteEntry(write, "failed", { error: "deadlock detected" });

    expect(settledLine(write, allowed, entry)).toEqual({
      kind: "failed",
      line: "214-row update failed",
      detail: "deadlock detected",
    });
  });

  test("denied says the reason the agent got", () => {
    expect(settledLine(write, { kind: "denied", reason: "wrong currency" }, undefined).line).toBe(
      "Denied: wrong currency"
    );
  });

  test.each([
    ["harness", "The Turn ended", "Expired: the turn ended before you answered"],
    ["daemon", "The Daemon restarted", "Expired: the daemon restarted before you answered"],
    ["daemon", "Interrupted", "Expired: the turn was stopped before you answered"],
    ["daemon", "The session was archived", "Expired: the session was archived"],
    ["harness", null, "Expired: the turn ended before you answered"],
    ["daemon", null, "Expired: the daemon restarted before you answered"],
  ] as const)("expired by the %s with %p says why there was no answer (F6)", (by, reason, line) => {
    expect(settledLine(write, { kind: "expired", by, reason }, undefined)).toEqual({
      kind: "expired",
      line,
    });
  });

  test("a write the agent's error withdrew keeps the error under the line (F6)", () => {
    expect(
      settledLine(write, { kind: "expired", by: "harness", reason: "rate limited" }, undefined)
    ).toEqual({
      kind: "expired",
      line: "Expired: the agent stopped with an error",
      detail: "rate limited",
    });
  });
});

test("Deny needs a reason, and sends it trimmed", () => {
  expect(denyDecision("")).toBeNull();
  expect(denyDecision("   \n")).toBeNull();
  expect(denyDecision("  use EUR for the 2025 ones \n")).toEqual(
    Decisions.Deny({ reason: "use EUR for the 2025 ones" })
  );
});

describe("the statement's colours", () => {
  test("runs join back to the statement exactly", () => {
    const sql = "update t\n  set a = 'it''s -- not a comment' -- set b\n where id = $1 /* x */";

    expect(
      sqlTokens(sql)
        .map((t) => t.text)
        .join("")
    ).toBe(sql);
  });

  test("a keyword inside a literal stays a string; a comment stays a comment", () => {
    const tokens = sqlTokens("update t set note = 'delete me' -- why not");

    expect(tokens.find((t) => t.text.includes("delete"))).toEqual({
      kind: "string",
      text: "'delete me'",
    });
    expect(tokens.at(-1)).toEqual({ kind: "comment", text: "-- why not" });
    expect(tokens[0]).toEqual({ kind: "keyword", text: "update" });
  });
});
