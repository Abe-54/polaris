import { expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { TracesRpcs } from "@polaris/protocol";
import { TracesRpcsLive } from "./rpcs.ts";
import { TraceRuntime } from "./runtime.ts";
import { TraceStore } from "./store.ts";
import { TEST_SESSION, withTraceFixture } from "./testing.ts";

test("each watch sends its endpoint on the first page only", () =>
  withTraceFixture(async (f) => {
    const layer = TracesRpcsLive.pipe(
      Layer.provide(
        Layer.mergeAll(Layer.succeed(TraceRuntime, f.runtime), Layer.succeed(TraceStore, f.store))
      )
    );

    const pages = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TracesRpcs);

          return yield* client["traces.watch"]({ sessionId: TEST_SESSION, filter: {} }).pipe(
            Stream.tap((page) => (page.endpoint === null ? Effect.void : f.store.notify)),
            Stream.take(2),
            Stream.runCollect,
            Effect.timeout("3 seconds")
          );
        }).pipe(Effect.provide(layer))
      )
    );

    expect(pages[0]?.endpoint).toBe(f.endpoint);
    expect(pages[1]?.endpoint).toBeNull();
    expect(JSON.stringify(pages[1])).not.toContain(f.endpoint!.split("/").at(-1)!);
  }));
