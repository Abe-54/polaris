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
  withParams,
} from "../preview/writeFixtures.ts";
import {
  cellChanges,
  denyDecision,
  dryRunKicker,
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

  test("a write that couldn't be previewed says so and runs without preview", () => {
    const write = notPreviewedWrite();

    expect(dryRunKicker(write)).toBe("Not previewed: this table has triggers");
    expect(runLabel(write)).toBe("Run without preview");
    expect(writeWants(write)).toBe("wants to run an update without preview on app");
    expect(showingLine(write)).toBeNull();
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

  test("a failed run keeps the database's words", () => {
    const entry = fixtureWriteEntry(write, "failed", { error: "deadlock detected" });

    expect(settledLine(write, allowed, entry)).toEqual({
      kind: "failed",
      line: "214-row update failed",
      detail: "deadlock detected",
    });
  });

  test("denied says the reason the agent got; expired says why there was no answer", () => {
    expect(settledLine(write, { kind: "denied", reason: "wrong currency" }, undefined).line).toBe(
      "Denied: wrong currency"
    );
    expect(settledLine(write, { kind: "expired", by: "harness" }, undefined).line).toBe(
      "Expired: the turn ended before you answered"
    );
    expect(settledLine(write, { kind: "expired", by: "daemon" }, undefined).line).toBe(
      "Expired: the daemon restarted before you answered"
    );
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
