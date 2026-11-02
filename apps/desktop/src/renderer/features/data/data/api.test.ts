import { afterEach, expect, test } from "bun:test";
import { SchemaTree, SessionId, TableDetail } from "@polaris/protocol";
import { installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { liveDataApi } from "./api.ts";

afterEach(() => standInBridge(null));

const at = { hostKey: "local", sessionId: SessionId.make("s-overdue-totals") };

const on = {
  header: () => undefined,
  rows: () => undefined,
  end: () => undefined,
  failed: () => undefined,
};

test("a streamed query sends its params, and none when it has none", () => {
  const bridge = installFakeBridge();
  const sql = "select * from invoices where customer_id = $1";

  liveDataApi.queryStream?.(at, { source: "app", sql, params: ["c-42"], limit: 200 }, on);
  liveDataApi.queryStream?.(at, { source: "app", sql: "select 1" }, on);

  expect(bridge.feeds("data.query.stream").map(({ input }) => input)).toEqual([
    { ...at, source: "app", sql, params: ["c-42"], limit: 200 },
    { ...at, source: "app", sql: "select 1" },
  ]);
});

const users = new TableDetail({
  schema: "main",
  name: "users",
  columns: [{ name: "id", type: "INTEGER", nullable: false, default: null, pk: true, fk: null }],
  indexes: [],
  constraints: [],
  rowEstimate: 3,
});

test("a described table crosses IPC as a TableDetail, so the Table tab reads its rows", async () => {
  const bridge = installFakeBridge();

  // IPC is a structured clone: the class's prototype doesn't survive it.
  bridge.answerOk("data.describe", structuredClone(users));
  const result = await liveDataApi.describe(at, { source: "polaris.sqlite", table: "users" });

  expect(result.ok && result.value instanceof TableDetail).toBe(true);
});

test("a schema tree crosses IPC as a SchemaTree, so the SQL catalog loads", async () => {
  const bridge = installFakeBridge();

  const tree = new SchemaTree({
    loadedAt: "2026-11-02T00:00:00Z",
    schemas: [],
    truncatedTables: 0,
  });

  bridge.answerOk("data.describe", structuredClone(tree));
  const result = await liveDataApi.describe(at, { source: "web/app" });

  expect(result.ok && result.value instanceof SchemaTree).toBe(true);
});
