/** Every Data RPC goes through the real transport, including write-only password decoding. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  connectRpcWith,
  socketTransport,
  watchDataSources,
  watchDataQueryLog,
} from "@polaris/client";
import { DaemonRpcs, SessionId, Unsupported } from "@polaris/protocol";
import { Effect, Layer, Redacted, Stream } from "effect";
import { shortTemp } from "../platform/testing.ts";
import { HostSecrets } from "../secrets/index.ts";
import { startServer } from "../transport/server.ts";
import { DataSourceAccess } from "./access.ts";
import { sources } from "./sources.ts";
import { memorySecrets } from "../secrets/index.ts";
import { DataSources, DataQueries, DataRpcsLive } from "./index.ts";

const sessionId = SessionId.make("data-session");

const label = { text: "Local", colour: "none" } as const;

test("Data RPC serves discovered/manual metadata and never returns write-only credentials", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = mkdtempSync(shortTemp("pl-data-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(root, { recursive: true, force: true }))
        );

        const access = yield* DataSourceAccess.pipe(Effect.provide(DataSourceAccess.layer));

        const sourceLayer = Layer.effect(
          DataSources,
          sources({
            path: join(root, "data.sqlite"),
            checkout: () => Effect.succeed(root),
            secrets: memorySecrets(),
            access,
          })
        );

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers: DataRpcsLive.pipe(
            Layer.provide(
              Layer.merge(
                sourceLayer,
                Layer.succeed(
                  DataQueries,
                  DataQueries.of({
                    query: () => Effect.fail(new Unsupported({ capability: "data" })),
                    describe: () => Effect.fail(new Unsupported({ capability: "data" })),
                    queryStream: () => Stream.empty,
                    watchLog: () => Stream.succeed([]),
                    pageLog: () => Effect.succeed({ entries: [], next: null }),
                    awaitApproval: () => Effect.succeed({ status: "pending" }),
                    recordOutside: () => Effect.void,
                  })
                )
              )
            )
          ),
          capabilities: ["data"],
          secrets: HostSecrets.memory(),
        });

        const { client } = yield* connectRpcWith(
          DaemonRpcs,
          yield* socketTransport(server.socketPath)
        );

        const { capabilities } = yield* client.hello({
          clientName: "data-test",
          clientVersion: "0",
          deviceLabel: "test",
          capabilities: [],
        });

        expect(capabilities).toContain("data");
        expect(
          yield* Stream.runCollect(
            watchDataSources({ client, capabilities }, { sessionId }).pipe(Stream.take(1))
          )
        ).toEqual([[]]);
        expect(
          yield* Stream.runCollect(watchDataQueryLog({ client, capabilities }, { sessionId }))
        ).toEqual([[]]);
        const source = { sessionId, source: "app" };

        const requests = [
          client["data.describe"](source).pipe(Effect.asVoid),
          client["data.query"]({ ...source, sql: "select 1", params: [], limit: 1 }).pipe(
            Effect.asVoid
          ),
        ];

        for (const request of requests) {
          expect(yield* Effect.flip(request)).toEqual(new Unsupported({ capability: "data" }));
        }

        const saved = yield* client["data.source.save"]({
          sessionId,
          name: "manual",
          engine: "postgres",
          host: "localhost",
          port: 5432,
          database: "ledger",
          user: "u",
          password: Redacted.make("p a'ss@word"),
          label,
        });

        const labelled = yield* client["data.source.label"]({
          ...source,
          source: "manual",
          label: { text: "LOCAL", colour: "none" },
        });

        const snapshots = yield* Stream.runCollect(
          watchDataSources({ client, capabilities }, { sessionId }).pipe(Stream.take(1))
        );

        expect(snapshots[0]?.[0]).toMatchObject({
          name: "manual",
          database: "ledger",
          locality: "remote",
          label: { text: "LOCAL", colour: "none" },
        });
        expect(JSON.stringify({ saved, labelled, snapshots })).not.toMatch(
          /postgres:\/\/|password|p a'ss/
        );
        yield* client["data.source.remove"]({ ...source, source: "manual" });
        expect(
          yield* Stream.runCollect(
            watchDataSources({ client, capabilities }, { sessionId }).pipe(Stream.take(1))
          )
        ).toEqual([[]]);
      })
    )
  ));
