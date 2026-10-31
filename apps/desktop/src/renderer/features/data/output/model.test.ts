import { describe, expect, test } from "bun:test";
import { QueryLogEntry, RequestId, type SchemaSourceDiff, TurnId } from "@polaris/protocol";
import { FIXTURE_QUERY_LOG, FIXTURE_SESSIONS } from "../preview/fixtures.ts";
import { fixtureWrite, fixtureWriteApproval, fixtureWriteEntry } from "../preview/writeFixtures.ts";
import {
  hasData,
  readsLine,
  turnData,
  type TurnDataInput,
  writeStatus,
  writeTable,
} from "./model.ts";

const backfill = FIXTURE_SESSIONS.backfill.id;

const write = fixtureWrite();

const input = (change: Partial<TurnDataInput> = {}): TurnDataInput => ({
  entries: FIXTURE_QUERY_LOG,
  sessionId: backfill,
  turnIds: new Set(["turn-4"]),
  pending: [],
  settled: [],
  schema: [],
  ...change,
});

const schemaSource = (
  tables: number,
  status: SchemaSourceDiff["status"] = "complete"
): SchemaSourceDiff => ({
  source: { id: "src-app", name: "app" },
  status,
  baseline: "turn-start",
  beforeAt: null,
  afterAt: null,
  truncated: false,
  tables: Array.from({ length: tables }, (_, i) => ({
    kind: "added" as const,
    before: null,
    after: { schema: "public", name: `t${i}` },
    columns: [],
    indexes: [],
    constraints: [],
    rows: { kind: "unknown" as const, value: null },
  })),
});

describe("the Data tab groups one Turn's data", () => {
  test("only this session's Queries in this Turn count; the user's own queries never do", () => {
    const data = turnData(input());

    // turn-4 of Backfill currency: eight reads plus its psql outside Polaris.
    expect(data.reads.length).toBe(9);
    expect(data.reads.at(-1)?.id).toBe("q-outside");
    expect(data.reads.some((e) => e.author.kind === "user")).toBe(false);
    expect(data.writes).toEqual([]);
    expect(readsLine(data.reads.length)).toBe("9 reads");
  });

  test("a write is a write card linked to its approval; its dry run never shows twice", () => {
    const approval = fixtureWriteApproval(write);

    const data = turnData(
      input({
        turnIds: new Set(["turn-5"]),
        entries: [
          ...FIXTURE_QUERY_LOG.filter((e) => e.id !== "q-backfill-write"),
          fixtureWriteEntry(write, "dry-run", { id: `${write.queryId}:dry-run`, rows: 214 }),
          fixtureWriteEntry(write, "waiting-approval", {
            approval: { id: approval.id, status: "pending" },
          }),
        ],
        pending: [approval],
      })
    );

    expect(data.writes).toHaveLength(1);
    expect(data.writes[0]?.approval?.request.id).toBe(approval.id);
    expect(data.reads).toEqual([]);
    expect(writeStatus(data.writes[0]!).line).toBe("Waiting for you");
  });

  test("a settled approval says how it ended; the Query Log alone says what it saw", () => {
    const approval = fixtureWriteApproval(write);
    const ran = fixtureWriteEntry(write, "completed", { rows: 214 });

    const [linked] = turnData(
      input({
        turnIds: new Set(["turn-5"]),
        entries: [ran],
        settled: [{ request: approval, outcome: { kind: "allowed" } }],
      })
    ).writes;

    expect(writeStatus(linked!).line).toBe("Ran 214-row update");

    const denied = fixtureWriteEntry(write, "failed", {
      approval: { id: RequestId.make("r-gone"), status: "denied" },
      error: "Use EUR for 2025",
    });

    const [alone] = turnData(input({ turnIds: new Set(["turn-5"]), entries: [denied] })).writes;

    expect(alone?.approval).toBeNull();
    expect(writeStatus(alone!)).toEqual({ kind: "denied", line: "Denied: Use EUR for 2025" });
  });

  test("after a reload, a write that expired unanswered says why, never Denied (F6)", () => {
    const expired = fixtureWriteEntry(write, "expired", {
      approval: { id: RequestId.make("r-stop"), status: "expired", reason: "Interrupted" },
    });

    const [alone] = turnData(input({ turnIds: new Set(["turn-5"]), entries: [expired] })).writes;

    expect(writeStatus(alone!)).toEqual({
      kind: "cancelled",
      line: "Expired: the turn was stopped before you answered",
    });
  });

  test("schema changes count, and a source with none doesn't", () => {
    expect(turnData(input({ schema: [schemaSource(2), schemaSource(0)] })).schema).toHaveLength(1);
    expect(turnData(input({ schema: [schemaSource(0, "pending")] })).schema).toHaveLength(1);
  });
});

describe("the tab is absent when the Turn touched no data", () => {
  test("a Turn with no Queries and no schema change has no Data tab", () => {
    expect(hasData(turnData(input({ turnIds: new Set(["turn-99"]) })))).toBe(false);
    expect(hasData(turnData(input({ entries: [], schema: [schemaSource(0)] })))).toBe(false);
  });

  test("another session's Queries in a Turn with the same id don't make one", () => {
    const other = new QueryLogEntry({
      id: "q-other",
      checkout: "/c",
      source: { id: "src-app", name: "app" },
      sql: "select 1",
      state: "completed",
      at: new Date(0).toISOString(),
      author: {
        kind: "agent",
        sessionId: FIXTURE_SESSIONS.overdue.id,
        turn: TurnId.make("turn-5"),
      },
    });

    expect(hasData(turnData(input({ entries: [other], turnIds: new Set(["turn-5"]) })))).toBe(
      false
    );
  });

  test("one read, one write or one schema change is enough", () => {
    expect(hasData(turnData(input()))).toBe(true);
    expect(hasData(turnData(input({ entries: [], schema: [schemaSource(1)] })))).toBe(true);
  });
});

test("Open in Data opens the table the Daemon counted, else the SQL's, in the default schema", () => {
  const counted = fixtureWriteEntry(write, "completed", {
    affected: [{ schema: "billing", table: "invoices", rows: 214 }],
  });

  expect(writeTable(counted, "public")).toEqual({ schema: "billing", name: "invoices" });
  expect(writeTable(fixtureWriteEntry(write, "running"), "public")).toEqual({
    schema: "public",
    name: "invoices",
  });
});
