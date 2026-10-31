// RT1 repro (ENG-656): error Spans have no age or size bound. Expected to FAIL on 08798fa8f.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { postTraces, spanFixture, traceFixture, withTraceFixture } from "./testing.ts";

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

      const row = db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM spans").get() as {
        bytes: number;
      };

      db.close();
      // 500 error Spans, each 31 days past a one-day limit, against a 20 kB budget.
      expect(row.bytes).toBe(0);
    },
    { maxBytes: MAX_BYTES, maxAgeMs: 86400_000 }
  ));

test("recent error Spans are capped oldest first, while an explicitly pinned error survives", () =>
  withTraceFixture(
    async (f) => {
      const pinned = "ffffffffffffffffffffffffffffffff";
      expect(
        (
          await postTraces(
            f.endpoint!,
            traceFixture([spanFixture({ traceId: pinned, error: true })])
          )
        ).status
      ).toBe(200);
      await Effect.runPromise(f.store.link(f.root, pinned));
      const base = BigInt(Date.now() - 1000) * 1_000_000n;

      for (let batch = 0; batch < 5; batch++) {
        const spans = Array.from({ length: 20 }, (_, index) =>
          spanFixture({
            traceId: (batch * 20 + index + 1).toString(16).padStart(32, "0"),
            error: true,
            start: (base + BigInt(batch * 20 + index)).toString(),
          })
        );

        expect((await postTraces(f.endpoint!, traceFixture(spans))).status).toBe(200);
      }

      await Effect.runPromise(f.store.flush);
      const db = new Database(join(f.root, "traces.sqlite"), { readonly: true });

      try {
        // SAFETY: the SQL aggregate always yields one numeric row.
        const row = db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM spans").get() as {
          bytes: number;
        };

        expect(row.bytes).toBeLessThanOrEqual(MAX_BYTES * 2);
        expect(
          (await Effect.runPromise(f.store.list(f.root))).traces.some(
            (trace) => trace.id === pinned
          )
        ).toBe(true);
        expect(
          await Effect.runPromise(
            Effect.flip(f.store.get(f.root, "00000000000000000000000000000001"))
          )
        ).toHaveProperty("code", "E-TRACE-NOT-FOUND");
        expect(
          (await Effect.runPromise(f.store.get(f.root, "00000000000000000000000000000064"))).spans
        ).toHaveLength(1);
      } finally {
        db.close();
      }
    },
    { maxBytes: MAX_BYTES }
  ));
