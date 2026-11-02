import { expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DomainEvent, InlinePropose, Workspace, WorkspaceId } from "@polaris/protocol";
import { Effect, Layer, Result, Stream } from "effect";
import { RpcGroup, RpcTest } from "effect/rpc";
import { makeBenchDriver } from "../harness/bench/BenchDriver.ts";
import { HarnessRegistry } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { InlineRpcsLive } from "./index.ts";
import { request } from "./testing.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

test("inline.propose serves the streamed contract without writing disk or committed state", async () => {
  const root = newTempDir("pi-inline-rpc-");
  const outside = newTempDir("pi-inline-outside-");
  const previous = process.env.POLARIS_BENCH_HARNESS;
  process.env.POLARIS_BENCH_HARNESS = "1";
  writeFileSync(join(root, "a.ts"), "disk content");
  writeFileSync(join(outside, "a.ts"), "outside content");
  symlinkSync(join(outside, "a.ts"), join(root, "escape.ts"));

  const driver = makeBenchDriver("codex");

  const registry = Layer.succeed(HarnessRegistry)(
    HarnessRegistry.of({ get: () => Effect.succeed(driver), all: Effect.succeed([driver]) })
  );

  const handlers = InlineRpcsLive.pipe(
    Layer.provideMerge(EventStore.layerSqlite(":memory:")),
    Layer.provide(registry)
  );

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore;

          const workspace = new Workspace({
            id: WorkspaceId.make("w"),
            path: root,
            name: "inline",
            isGitRepo: false,
            hidden: false,
            worktreeRoot: root,
            registeredAt: new Date().toISOString(),
          });

          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([DomainEvent.cases.WorkspaceRegistered.make({ workspace })]),
          });

          const sequence = (yield* store.model).sequence;
          const rpc = yield* RpcTest.makeClient(RpcGroup.make(InlinePropose));
          const input = { ...request(), path: join(root, "a.ts") };
          const items = yield* rpc["inline.propose"](input).pipe(Stream.runCollect);

          expect(items.at(-1)).toMatchObject({ patch: { summary: "Scripted inline edit" } });
          expect((yield* store.model).sequence).toBe(sequence);
          expect((yield* store.model).sessions.size).toBe(0);

          for (const path of [join(outside, "a.ts"), join(root, "escape.ts")]) {
            const result = yield* rpc["inline.propose"]({ ...input, path }).pipe(
              Stream.runCollect,
              Effect.result
            );

            expect(Result.isFailure(result) && result.failure.reason).toBe("invalid-request");
          }
        })
      ).pipe(Effect.provide(handlers))
    );
    expect(await Bun.file(join(root, "a.ts")).text()).toBe("disk content");
  } finally {
    if (previous === undefined) delete process.env.POLARIS_BENCH_HARNESS;
    else process.env.POLARIS_BENCH_HARNESS = previous;

    removeTempDir(root);
    removeTempDir(outside);
  }
});
