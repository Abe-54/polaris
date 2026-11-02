import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import { HostStreamItem, Sequence } from "@polaris/protocol";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Stream } from "effect";
import { ServerRpcs } from "./rpcs.ts";
import { startServer } from "./server.ts";
import { scopedTempDir } from "../platform/tempDir.testing.ts";

const temporary = scopedTempDir("pl-die-", { short: true });

const snapshot = HostStreamItem.cases.Snapshot.make({
  sequence: Sequence.make(0),
  workspaces: [],
  worktrees: [],
  sessions: [],
});

/** One Client connection with a host stream and a request in flight when another request dies. */
const dieBesideOthers = async () => {
  const logs: Array<string> = [];
  const logger = Logger.make((entry) => logs.push(Logger.formatSimple.log(entry)));

  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();

        const handlers = Layer.mergeAll(
          ServerRpcs.toLayerHandler("subscribeHost", () =>
            Stream.concat(Stream.succeed(snapshot), Stream.never)
          ),
          ServerRpcs.toLayerHandler("harness.spinnerVerbs", () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as(null)
            )
          ),
          ServerRpcs.toLayerHandler("files.listDir", ({ path }) =>
            Effect.die(new Error(`listing ${path} broke`))
          )
        );

        const server = yield* startServer({
          root,
          socketPath: join(root, "daemon.sock"),
          lockPath: join(root, "daemon.lock"),
          handlers,
        });

        const rpc = yield* connectRpc(yield* socketTransport(server.socketPath));
        const lost = yield* Effect.forkScoped(rpc.lost);
        const first = yield* Deferred.make<HostStreamItem>();

        const feed = yield* rpc.client.subscribeHost({ afterSequence: null }).pipe(
          Stream.runForEach((item) => Deferred.succeed(first, item)),
          Effect.forkScoped
        );

        yield* Deferred.await(first);
        const pending = yield* Effect.forkScoped(rpc.client["harness.spinnerVerbs"]({ cwd: null }));
        yield* Deferred.await(entered);
        const died = yield* Effect.exit(rpc.client["files.listDir"]({ path: "/broken" }));
        yield* Deferred.succeed(gate, undefined);

        return {
          died,
          pending: yield* Fiber.await(pending),
          after: yield* Effect.exit(rpc.client["harness.spinnerVerbs"]({ cwd: null })),
          feedOpen: feed.pollUnsafe() === undefined,
          connected: lost.pollUnsafe() === undefined,
        };
      })
    ).pipe(Effect.provide(Logger.layer([logger])))
  );

  return { ...outcome, logs };
};

test("a handler's defect fails only its request; the connection's stream and requests go on", async () => {
  const { died, pending, after, feedOpen, connected } = await dieBesideOthers();

  expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBe(true);
  expect(Exit.isFailure(died) ? Cause.pretty(died.cause) : "").toContain("listing /broken broke");
  expect({ pending, after, feedOpen, connected }).toEqual({
    pending: Exit.succeed(null),
    after: Exit.succeed(null),
    feedOpen: true,
    connected: true,
  });
});

test("the Daemon logs a handler's defect at error level, naming the RPC and the cause", async () => {
  const { logs } = await dieBesideOthers();

  const logged = logs.filter((line) => line.includes("RPC files.listDir died"));

  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain("level=ERROR");
  expect(logged[0]).toContain("listing /broken broke");
});
