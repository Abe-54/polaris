/** Real RPC framing and cancellation with a fake Query executor boundary. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connectRpcWith, queryDataStream, socketTransport } from "@polaris/client";
import { DaemonRpcs, SessionId, Unsupported, QueryDataStreamItem } from "@polaris/protocol";
import { Deferred, Effect, Layer, Stream } from "effect";
import { shortTemp } from "../platform/testing.ts";
import { HostSecrets } from "../secrets/index.ts";
import { startServer } from "../transport/server.ts";
import { sources } from "./sources.ts";
import { memorySecrets } from "../secrets/index.ts";
import { DataSources, DataQueries, DataRpcsLive, DataSourceAccess } from "./index.ts";

const sessionId = SessionId.make("stream-session");

const unavailable = () => Effect.fail(new Unsupported({ capability: "data" }));

test("F4/F6: 10k rows cross the real stream; cancellation closes the executor scope", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = mkdtempSync(shortTemp("pl-dstream-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(root, { recursive: true, force: true }))
        );
        const cancelled = yield* Deferred.make<void>();

        const queries = Layer.succeed(
          DataQueries,
          DataQueries.of({
            awaitApproval: () => Effect.succeed({ status: "pending" }),
            recordOutside: () => Effect.void,
            describe: unavailable,
            query: unavailable,
            pageLog: unavailable,
            watchLog: () => Stream.succeed([]),
            queryStream: (input) => {
              const header = QueryDataStreamItem.cases.Header.make({
                queryId: "q-stream",
                columns: [
                  { name: "id", type: "int" },
                  { name: "text", type: "text" },
                ],
              });

              if (input.sql === "wait")
                return Stream.concat(Stream.succeed(header), Stream.never).pipe(
                  Stream.ensuring(Deferred.succeed(cancelled, undefined))
                );

              const chunks = Array.from({ length: 20 }, (_, chunk) =>
                QueryDataStreamItem.cases.Rows.make({
                  rows: Array.from({ length: 500 }, (_, row) => [
                    chunk * 500 + row,
                    "x".repeat(2000),
                  ]),
                })
              );

              return Stream.fromIterable([
                header,
                ...chunks,
                QueryDataStreamItem.cases.End.make({
                  returned: 10000,
                  total: 18402,
                  truncated: true,
                  elapsedMs: 1,
                }),
              ]);
            },
          })
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
          handlers: DataRpcsLive.pipe(Layer.provide(Layer.merge(sourceLayer, queries))),
          capabilities: ["data"],
          secrets: HostSecrets.memory(),
        });

        const { client } = yield* connectRpcWith(
          DaemonRpcs,
          yield* socketTransport(server.socketPath)
        );

        const session = { client, capabilities: ["data"] as const };

        const chunks = yield* Stream.runCollect(
          queryDataStream(session, { sessionId, source: "app", sql: "select id", limit: 10000 })
        );

        expect(chunks[0]).toEqual(
          QueryDataStreamItem.cases.Header.make({
            queryId: "q-stream",
            columns: [
              { name: "id", type: "int" },
              { name: "text", type: "text" },
            ],
          })
        );

        const rows = chunks.flatMap((chunk) =>
          QueryDataStreamItem.guards.Rows(chunk) ? chunk.rows : []
        );

        expect(rows).toHaveLength(10000);
        expect(rows[9999]?.[0]).toBe(9999);
        expect(rows[9999]?.[1]).toBe("x".repeat(2000));
        expect(chunks.at(-1)).toEqual(
          QueryDataStreamItem.cases.End.make({
            returned: 10000,
            total: 18402,
            truncated: true,
            elapsedMs: 1,
          })
        );
        yield* queryDataStream(session, { sessionId, source: "app", sql: "wait" }).pipe(
          Stream.take(1),
          Stream.runDrain
        );
        yield* Deferred.await(cancelled).pipe(Effect.timeout("2 seconds"));
      })
    )
  ));
