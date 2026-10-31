import { expect, test } from "bun:test";
import { TracesRpcs } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { TracesRpcsLive } from "./rpcs.ts";
import { TraceRuntime } from "./runtime.ts";
import { TraceStore } from "./store.ts";
import {
  spanFixture,
  traceFixture,
  TEST_SESSION,
  TRACE_ID,
  SPAN_ID,
  withTraceFixture,
} from "./testing.ts";

test("traces.get exposes batched medians and actual sample counts from earlier checkout history", () =>
  withTraceFixture(async (f) => {
    const now = BigInt(Date.now()) * 1_000_000n;

    const ingest = async (
      traceId: string,
      ms: number,
      offset: number,
      parentName = "request",
      checkout = f.root
    ) => {
      const start = (now + BigInt(offset) * 1_000_000n).toString();
      const root = { ...spanFixture({ traceId, start }), name: parentName };

      const child = {
        ...spanFixture({ traceId, id: "2222222222222222", start, parentId: SPAN_ID }),
        name: "query",
        endTimeUnixNano: (BigInt(start) + BigInt(ms) * 1_000_000n).toString(),
      };

      await Effect.runPromise(
        f.store.ingest({
          bytes: new TextEncoder().encode(JSON.stringify(traceFixture([root, child]))),
          signal: "traces",
          contentType: "application/json",
          context: { ...f.context, checkout },
        })
      );
    };

    await ingest(TRACE_ID, 112, 0);

    for (const [i, ms] of [1, 3, 9, 11].entries())
      await ingest(String(i + 1).repeat(32), ms, -1000 + i);

    let historyCalls = 0;

    const store = TraceStore.of({
      ...f.store,
      history: (...args) => {
        historyCalls++;

        return f.store.history(...args);
      },
    });

    const read = () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const rpc = yield* RpcTest.makeClient(TracesRpcs);

            return yield* rpc["traces.get"]({
              sessionId: TEST_SESSION,
              traceId: TRACE_ID.slice(0, 8),
            });
          })
        ).pipe(
          Effect.provide(TracesRpcsLive),
          Effect.provide(Layer.succeed(TraceStore, store)),
          Effect.provide(Layer.succeed(TraceRuntime, f.runtime))
        )
      );

    expect((await read()).usual).toEqual({});
    expect(historyCalls).toBe(1);
    await ingest("5".repeat(32), 100, -900);
    await ingest("6".repeat(32), 1000, -800);
    // Other checkouts, later traces and a different parent name must not change the baseline.
    await ingest("7".repeat(32), 5000, -700, "other request");
    await ingest("8".repeat(32), 5000, 1000);
    await ingest("9".repeat(32), 5000, -600, "request", "another-checkout");

    const detail = await read();
    expect(detail.usual?.["2222222222222222"]).toEqual({ usualMs: 10, samples: 6 });
    expect(detail.usual?.[SPAN_ID]?.samples).toBe(6);
    expect(detail.spans.find((s) => s.id === "2222222222222222")?.durationMs).toBe(112);
    expect(historyCalls).toBe(2);
  }));
