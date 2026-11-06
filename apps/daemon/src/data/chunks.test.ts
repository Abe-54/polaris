import { expect, test } from "bun:test";
import { DataValueTags, QueryDataStreamItem, dataJsonBytes } from "@polaris/protocol";
import { Schema } from "effect";
import { resultChunks } from "./chunks.ts";

test("a wide row whose cells each fit is clipped to the RPC chunk limit and End reports truncation", () => {
  const rows = Array.from({ length: 2 }, () =>
    Array.from({ length: 256 }, () =>
      DataValueTags.cases.Json.make({ text: JSON.stringify({ payload: "x".repeat(50000) }) })
    )
  );

  const items = resultChunks({
    queryId: "q",
    columns: Array.from({ length: 256 }, (_, i) => ({ name: String(i), type: "json" })),
    rows,
    truncated: false,
    elapsedMs: 1,
  });

  for (const item of items) {
    expect(dataJsonBytes(item)).toBeLessThanOrEqual(1048576);
    expect(() => Schema.encodeSync(QueryDataStreamItem)(item)).not.toThrow();
  }

  expect(items.at(-1)).toEqual(
    QueryDataStreamItem.cases.End.make({ returned: 2, truncated: true, elapsedMs: 1 })
  );
});
