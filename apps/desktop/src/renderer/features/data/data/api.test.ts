import { afterEach, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
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
