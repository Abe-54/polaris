/** Host stats over the real transport: a Client's watch decodes, and its disconnect stops sampling. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectRpcWith, socketTransport, watchHostStats } from "@polaris/client";
import { DaemonRpcs, HostStatsItem } from "@polaris/protocol";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { HostSecrets } from "../secrets/index.ts";
import { startServer } from "../transport/server.ts";
import { HostStats, HostStatsRpcsLive } from "./index.ts";
import type { HostProbe } from "./probe.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const hello = { clientName: "test", clientVersion: "0", deviceLabel: "test", capabilities: [] };

test("a Client watches History then samples, and closing its connection stops sampling", () => {
  let reads = 0;

  const probe: HostProbe = {
    cores: () => 4,
    read: () => {
      reads += 1;

      return {
        cpu: { busy: reads, total: reads * 4 },
        loadAverage: [0.5, 0.25, 0.125],
        memory: { usedBytes: 2 ** 33, totalBytes: 2 ** 34 },
        disk: null,
      };
    },
  };

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = newTempDir("pl-hoststats-", { short: true });
        yield* Effect.addFinalizer(() => Effect.promise(() => removeTempDirSettled(root)));

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers: HostStatsRpcsLive.pipe(
            Layer.provide(HostStats.layer({ probe, intervalMs: 20 }))
          ),
          capabilities: ["host.stats"],
          secrets: HostSecrets.memory(),
        });

        const connectionScope = yield* Scope.make();

        const { client } = yield* connectRpcWith(
          DaemonRpcs,
          yield* socketTransport(server.socketPath)
        ).pipe(Scope.provide(connectionScope));

        const { capabilities } = yield* client.hello(hello);

        const items = yield* Stream.runCollect(
          Stream.take(watchHostStats({ capabilities, client }), 3)
        );

        expect(items.map((item) => item._tag)).toEqual(["History", "Sample", "Sample"]);
        const last = items[2];
        expect(
          last !== undefined && HostStatsItem.guards.Sample(last) && last.sample
        ).toMatchObject({
          cpuPercent: 25,
          memoryUsedBytes: 2 ** 33,
          loadAverage: [0.5, 0.25, 0.125],
        });

        // Kept open until the connection closes: a watch that ends with it stops sampling.
        yield* Stream.runDrain(watchHostStats({ capabilities, client })).pipe(
          Effect.forkIn(connectionScope)
        );
        yield* Effect.sleep("100 millis");
        yield* Scope.close(connectionScope, Exit.void);
        yield* Effect.sleep("100 millis");
        const after = reads;
        yield* Effect.sleep("200 millis");

        expect(reads).toBe(after);
      })
    )
  );
});
