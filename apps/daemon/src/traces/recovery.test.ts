import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { traceFixture, spanFixture, TRACE_ID, withTraceFixture } from "./testing.ts";

test("a failed transaction preserves other checkouts and retries on the next request", () =>
  withTraceFixture(
    async (f) => {
      const ingest = (checkout: string, id: string) =>
        f.store.ingest({
          bytes: Buffer.from(JSON.stringify(traceFixture([spanFixture({ id })]))),
          contentType: "application/json",
          signal: "traces",
          context: { ...f.context, checkout },
        });

      await Effect.runPromise(ingest("seed", "0000000000000001"));
      await Effect.runPromise(f.store.flush);
      const db = new Database(join(f.root, "traces.sqlite"));

      try {
        db.exec(
          "CREATE TRIGGER fail_ingest BEFORE INSERT ON spans WHEN NEW.checkout='bad' BEGIN SELECT RAISE(ABORT, 'disk failure'); END"
        );
        await Effect.runPromise(ingest("good", "0000000000000002"));
        await Effect.runPromise(ingest("bad", "0000000000000003"));
        expect((await Effect.runPromise(Effect.flip(f.store.flush))).code).toBe(
          "E-TRACE-UNAVAILABLE"
        );
        expect(
          await Effect.runPromise(Effect.flip(ingest("good", "0000000000000004")))
        ).toHaveProperty("status", 503);
        db.exec("DROP TRIGGER fail_ingest");
        await Effect.runPromise(ingest("good", "0000000000000004"));
        const good = await Effect.runPromise(f.store.get("good", TRACE_ID));
        expect(good.spans.map((span) => span.id)).toEqual(["0000000000000002", "0000000000000004"]);
        expect((await Effect.runPromise(f.store.get("bad", TRACE_ID))).spans[0]?.id).toBe(
          "0000000000000003"
        );
      } finally {
        db.close();
      }
    },
    { flushMs: 60_000 }
  ));
