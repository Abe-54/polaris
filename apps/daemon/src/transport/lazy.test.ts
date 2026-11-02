import { expect, test } from "bun:test";
import { join } from "node:path";
import { BlobId } from "@polaris/protocol";
import { Cause, Effect, Fiber, Exit, Layer, Scope, Schema, Stream } from "effect";
import { Headers } from "effect/http";
import { Rpc, RpcGroup } from "effect/rpc";
import { RequestId } from "effect/rpc/RpcMessage";
import { BlobChannel } from "../services.ts";
import { ConnectionBlobs } from "./rpcs.ts";
import { cacheDaemonBuild, lazyRpcLayer } from "./lazy.ts";

test("Daemon startup does not import the language runtime, catalog, installer or preview media", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      // Windows keys require.cache by backslashed paths; compare them with forward slashes.
      `await import(${JSON.stringify(join(import.meta.dir, "serve.ts"))});
     console.log(JSON.stringify(Object.keys(require.cache).map(path => path.replaceAll("\\\\", "/")).filter(path => path.includes("/apps/daemon/src/languages/"))));`,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const imported = Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(output));
  expect(imported.map((path) => path.split("/languages/")[1])).toEqual([
    "composition/environment.ts",
  ]);
});

const rpcs = RpcGroup.make(
  Rpc.make("test.read", { success: Schema.String }),
  Rpc.make("test.watch", { success: Schema.String, stream: true })
).middleware(ConnectionBlobs);

const blobs = (name: string): BlobChannel["Service"] => ({
  offer: () => Effect.succeed(BlobId.make(name)),
  take: () => Effect.succeed(new Uint8Array()),
  takeStream: () => Stream.empty,
});

test("lazy RPCs share one Daemon build while streams retain request Scope and BlobChannel", async () => {
  let builds = 0;
  let closed = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* Effect.scope;
        const memo = yield* Layer.makeMemoMap;

        const read = Effect.gen(function* () {
          expect(yield* Effect.scope).not.toBe(daemon);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed++;
            })
          );

          return yield* (yield* BlobChannel).offer(new Uint8Array());
        });

        const load = yield* Effect.cached(
          Effect.andThen(
            Effect.sync(() => {
              builds++;
            }),
            rpcs.toHandlers({
              "test.read": () => read,
              "test.watch": () => Stream.fromEffect(read),
            })
          ).pipe(Effect.provideService(BlobChannel, blobs("daemon")))
        );

        const handlers = yield* Layer.buildWithMemoMap(lazyRpcLayer(rpcs, load), memo, daemon);
        expect(builds).toBe(0);

        const options = {
          requestId: RequestId(1),
          headers: Headers.empty,
          client: new Rpc.ServerClient(1),
        };

        const request = Effect.scoped(
          Effect.gen(function* () {
            const read = yield* rpcs.accessHandler("test.read");

            return yield* read(undefined, options);
          })
        );

        const results = yield* Effect.all(
          [
            request.pipe(Effect.provideService(BlobChannel, blobs("one"))),
            request.pipe(Effect.provideService(BlobChannel, blobs("two"))),
          ],
          { concurrency: "unbounded" }
        ).pipe(Effect.provide(handlers));

        expect(results).toEqual(["one", "two"]);
        expect(builds).toBe(1);
        expect(closed).toBe(2);

        const values = yield* Effect.scoped(
          Effect.gen(function* () {
            const watch = yield* rpcs.accessHandler("test.watch");
            const result = watch(undefined, options);

            return yield* (Effect.isEffect(result) ? Stream.fromQueue(yield* result) : result).pipe(
              Stream.runCollect
            );
          })
        ).pipe(Effect.provide(handlers), Effect.provideService(BlobChannel, blobs("stream")));

        expect(values).toEqual(["stream"]);
        expect(closed).toBe(3);
        expect(builds).toBe(1);
      })
    )
  );
});

test("empty startup leaves transfer storage absent; persisted assignments activate recovery", async () => {
  const { Database } = await import("bun:sqlite");
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { emptyModel } = await import("../store/model.ts");

  const { constellationTransferPath, needsConstellationStartup } =
    await import("../constellation/composition/startup.ts");

  const root = mkdtempSync(join(tmpdir(), "polaris-lazy-startup-"));
  const path = constellationTransferPath(root);

  try {
    expect(await Effect.runPromise(needsConstellationStartup(root, emptyModel))).toBe(false);
    expect(existsSync(path)).toBe(false);
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE assignments (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    expect(await Effect.runPromise(needsConstellationStartup(root, emptyModel))).toBe(false);
    db.exec("INSERT INTO assignments VALUES ('mirror', '{}')");
    expect(await Effect.runPromise(needsConstellationStartup(root, emptyModel))).toBe(true);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled first lazy RPC cannot poison the Daemon service graph", async () => {
  let entered = () => {};

  let release = () => {};

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let builds = 0;
  let closed = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* Effect.scope;
        const memo = yield* Layer.makeMemoMap;

        const load = yield* cacheDaemonBuild(
          Effect.gen(function* () {
            builds++;
            entered();
            yield* Effect.promise(() => gate);
            yield* Scope.addFinalizer(
              daemon,
              Effect.sync(() => {
                closed++;
              })
            );

            return yield* rpcs.toHandlers({
              "test.read": () => Effect.succeed("ready"),
              "test.watch": () => Stream.succeed("ready"),
            });
          })
        );

        const handlers = yield* Layer.buildWithMemoMap(lazyRpcLayer(rpcs, load), memo, daemon);

        const options = {
          requestId: RequestId(1),
          headers: Headers.empty,
          client: new Rpc.ServerClient(1),
        };

        const read = Effect.gen(function* () {
          return yield* (yield* rpcs.accessHandler("test.read"))(undefined, options);
        }).pipe(Effect.provide(handlers));

        const first = yield* Effect.forkScoped(read);
        yield* Effect.promise(() => started);

        // Started now, so the interrupt is requested before the build is released.
        const cancelling = yield* Effect.forkScoped(Fiber.interrupt(first), {
          startImmediately: true,
        });

        release();
        yield* Fiber.join(cancelling);
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
        expect(yield* read).toBe("ready");
        expect(yield* read).toBe("ready");
        expect(builds).toBe(1);
        expect(closed).toBe(0);
      })
    )
  );
  expect(closed).toBe(1);
});

class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {
  rpc: Schema.String,
}) {}

test("a failed lazy build fails each request and stream with its typed error, not a defect", async () => {
  const exits = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* Effect.scope;
        const memo = yield* Layer.makeMemoMap;

        const load = yield* cacheDaemonBuild(
          Effect.andThen(
            Effect.fail("the graph did not build"),
            rpcs.toHandlers({
              "test.read": () => Effect.succeed("ready"),
              "test.watch": () => Stream.succeed("ready"),
            })
          )
        );

        const handlers = yield* Layer.buildWithMemoMap(
          lazyRpcLayer(rpcs, load, (tag) => new BuildFailed({ rpc: tag })),
          memo,
          daemon
        );

        const options = {
          requestId: RequestId(1),
          headers: Headers.empty,
          client: new Rpc.ServerClient(1),
        };

        const read = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              return yield* (yield* rpcs.accessHandler("test.read"))(undefined, options);
            })
          ).pipe(Effect.provide(handlers))
        );

        const watch = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const result = (yield* rpcs.accessHandler("test.watch"))(undefined, options);

              return yield* (
                Effect.isEffect(result) ? Stream.fromQueue(yield* result) : result
              ).pipe(Stream.runCollect);
            })
          ).pipe(Effect.provide(handlers))
        );

        return { read, watch };
      })
    ).pipe(Effect.provideService(BlobChannel, blobs("daemon")))
  );

  expect<unknown>(exits).toEqual({
    read: Exit.fail(new BuildFailed({ rpc: "test.read" })),
    watch: Exit.fail(new BuildFailed({ rpc: "test.watch" })),
  });
});

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const traced = RpcGroup.make(
  Rpc.make("test.span", { success: Schema.String }),
  Rpc.make("test.fail", { error: Refused })
);

test("a lazy handler runs under its own request's Span, not the request that built it", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* Effect.scope;
        const memo = yield* Layer.makeMemoMap;

        // Built as the Data handlers are: a handler Layer, on first use.
        const load = yield* cacheDaemonBuild(
          Layer.buildWithMemoMap(
            traced.toLayer({
              "test.span": () =>
                Effect.currentSpan.pipe(
                  Effect.map((span) => span.name),
                  Effect.catch(() => Effect.succeed("no span"))
                ),
              "test.fail": () => Effect.fail(new Refused()),
            }),
            memo,
            daemon
          )
        );

        const handlers = yield* Layer.buildWithMemoMap(lazyRpcLayer(traced, load), memo, daemon);

        const options = {
          requestId: RequestId(1),
          headers: Headers.empty,
          client: new Rpc.ServerClient(1),
        };

        const span = (name: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              return yield* (yield* traced.accessHandler("test.span"))(undefined, options);
            })
          ).pipe(Effect.provide(handlers), Effect.withSpan(name));

        // The first request builds the handlers, as a long-lived feed usually does.
        const first = yield* span("polaris.rpc.feed.watch");
        const second = yield* span("polaris.rpc.one.off");

        const failed = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              return yield* (yield* traced.accessHandler("test.fail"))(undefined, options);
            })
          ).pipe(Effect.provide(handlers), Effect.withSpan("polaris.rpc.failing"))
        );

        return { first, second, stack: Exit.isFailure(failed) ? Cause.pretty(failed.cause) : "" };
      })
    )
  );

  expect(result.stack).toContain("at polaris.rpc.failing");
  expect(result.stack).not.toContain("polaris.rpc.feed.watch");
  expect(result.first).toBe("polaris.rpc.feed.watch");
  expect(result.second).toBe("polaris.rpc.one.off");
});
