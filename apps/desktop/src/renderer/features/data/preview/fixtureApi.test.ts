import { describe, expect, test } from "bun:test";
import { SessionId, TableDetail } from "@polaris/protocol";
import { tableSql } from "../ui/table/sql.ts";
import { fixtureDataApi, runFixtureQuery } from "./fixtureApi.ts";
import { TABLE_SCENES } from "./scenes/table.ts";

const at = { hostKey: "local", sessionId: SessionId.make("s-overdue-totals") };

describe("Data fixtures", () => {
  test("a query filters on one equality and reports the full count past its limit", () => {
    const result = runFixtureQuery("select * from invoices where status = 'overdue'", 5);

    if (!result.ok) throw new Error(result.error.message);
    const status = result.value.columns.findIndex((c) => c.name === "status");

    expect(result.value.rows).toHaveLength(5);
    expect(result.value.rows.every((row) => row[status] === "overdue")).toBe(true);
    expect(result.value.rowCount).toBeGreaterThan(5);
    expect(result.value.truncated).toBe(true);
  });

  test("writes and unknown tables fail with the Data error codes", () => {
    const write = runFixtureQuery("update invoices set currency = 'USD'");
    const missing = runFixtureQuery("select * from nope");

    expect([write.ok ? null : write.error.code, missing.ok ? null : missing.error.code]).toEqual([
      "E-DATA-READ-ONLY",
      "E-DATA-SQL",
    ]);
  });

  test("the remote source without an approval is refused; the approved branch answers", async () => {
    const api = fixtureDataApi();
    const denied = await api.query(at, { source: "analytics", sql: "select 1 from users" });
    const branch = await api.query(at, { source: "ledger", sql: "select * from currencies" });

    expect(denied.ok ? null : denied.error.code).toBe("E-DATA-DENIED");
    expect(branch.ok ? branch.value.rowCount : null).toBe(4);
  });

  test("describe returns a table's detail with the sample rows asked for", async () => {
    const result = await fixtureDataApi().describe(at, {
      source: "app",
      table: "invoices",
      sample: 3,
    });

    const detail = result.ok && result.value instanceof TableDetail ? result.value : null;

    expect(detail?.sample?.rows).toHaveLength(3);
    expect(detail?.columns.find((c) => c.name === "customer_id")?.fk?.table).toBe("customers");
  });

  test("a page reads from its OFFSET: the bench's page 2 starts at id 1,001", async () => {
    const api = TABLE_SCENES.bench.api();

    const page = (offset: number) =>
      api.query(at, {
        source: "app",
        sql: tableSql({
          engine: "postgres",
          table: { schema: "public", name: "events" },
          filter: "",
          orderBy: ["id"],
          limit: 200,
          offset,
        }),
        limit: 200,
      });

    const [first, second] = await Promise.all([page(0), page(1000)]);

    expect(
      [first, second].map((r) => (r.ok ? [r.value.rows[0]?.[0], r.value.rows.at(-1)?.[0]] : r))
    ).toEqual([
      [1, 200],
      [1001, 1200],
    ]);
  });
});
