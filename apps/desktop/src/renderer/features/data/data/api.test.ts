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

// IPC is a structured clone: the class's prototype doesn't survive it.
test.each<
  [
    string,
    TableDetail | SchemaTree,
    Parameters<typeof liveDataApi.describe>[1],
    typeof TableDetail | typeof SchemaTree,
  ]
>([
  [
    "a described table crosses IPC as a TableDetail, so the Table tab reads its rows",
    users,
    { source: "polaris.sqlite", table: "users" },
    TableDetail,
  ],
  [
    "a schema tree crosses IPC as a SchemaTree, so the SQL catalog loads",
    new SchemaTree({ loadedAt: "2026-11-02T00:00:00Z", schemas: [], truncatedTables: 0 }),
    { source: "web/app" },
    SchemaTree,
  ],
])("%s", async (_case, answer, input, decoded) => {
  const bridge = installFakeBridge();

  bridge.answerOk("data.describe", structuredClone(answer));
  const result = await liveDataApi.describe(at, input);

  expect(result.ok && result.value instanceof decoded).toBe(true);
});
