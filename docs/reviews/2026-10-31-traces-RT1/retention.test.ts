// RT1 repro (ENG-656): error Spans have no age or size bound. Expected to FAIL on 08798fa8f.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import {
  postTraces,
  spanFixture,
  traceFixture,
  withTraceFixture,
} from "../../../apps/daemon/src/traces/testing.ts";

const MAX_BYTES = 20_000;

test("a checkout emitting only error Spans stays within a hard multiple of its budget", () =>
  withTraceFixture(
    async (f) => {
      const monthAgo = (BigInt(Date.now() - 31 * 86400_000) * 1_000_000n).toString();

      for (let batch = 0; batch < 5; batch++) {
        const spans = Array.from({ length: 100 }, (_, i) =>
          spanFixture({
            traceId: (batch * 100 + i + 1).toString(16).padStart(32, "0"),
            start: monthAgo,
            error: true,
          })
        );
        expect((await postTraces(f.endpoint!, traceFixture(spans))).status).toBe(200);
      }

      await Effect.runPromise(f.store.list(f.root));
      const db = new Database(join(f.root, "traces.sqlite"), { readonly: true });
      // SAFETY: the aggregate always returns one row with a numeric column.
      const row = db.query("SELECT sum(bytes) AS bytes FROM spans").get() as { bytes: number };
      db.close();
      // 500 error Spans, each 31 days past a one-day limit, against a 20 kB budget.
      expect(row.bytes).toBeLessThanOrEqual(MAX_BYTES * 4);
    },
    { maxBytes: MAX_BYTES, maxAgeMs: 86400_000 }
  ));
