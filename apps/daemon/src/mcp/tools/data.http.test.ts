import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DomainEvent, type TurnId } from "@polaris/protocol";
import { Effect, Layer, Redacted, Stream } from "effect";
import { DataSources, DataQueries } from "../../data/index.ts";
import { session, send } from "../../constellation/delivery/testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { shortTemp } from "../../platform/testing.ts";
import { McpTokens } from "../tokens.ts";
import { mcpHttp } from "../http.ts";
import { fakeCommands } from "../testing.ts";
import { bindings, result, source, table } from "./data.testing.ts";

for (const binding of bindings)
  test(`${binding._tag} Data tools over real MCP HTTP bind the current Turn`, async () => {
    const root = mkdtempSync(shortTemp("pl-m-data-"));
    const reads: Array<{ sessionId: string; turn?: TurnId; tool?: string }> = [];

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* EventStore;
            yield* store.commit({
              commandId: null,
              decide: () =>
                Effect.succeed([
                  DomainEvent.cases.SessionCreated.make({ session: session(binding.sessionId) }),
                ]),
            });
            yield* send(binding.sessionId, "Read invoices");
            const turn = (yield* store.model).sessions.get(binding.sessionId)!.turns[0]!.id;
            const { origin } = yield* mcpHttp(fakeCommands().commands);
            const tokens = yield* McpTokens;
            const token = yield* tokens.issue(binding);
            const client = new Client({ name: "data-test", version: "1" });

            yield* Effect.promise(async () => {
              try {
                // SAFETY: the SDK's optional sessionId differs only under exactOptionalPropertyTypes.
                await client.connect(
                  new StreamableHTTPClientTransport(new URL(`${origin}/mcp/${token}`)) as Transport
                );
                const listed = (await client.listTools()).tools;

                for (const name of ["data_sources", "describe", "query"])
                  expect(listed.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(
                    true
                  );
                const sources = await client.callTool({ name: "data_sources", arguments: {} });
                expect(sources.structuredContent).toMatchObject({ sources: [{ name: "app" }] });

                const described = await client.callTool({
                  name: "describe",
                  arguments: { source: "app", table: "public.invoices", sample: 1 },
                });

                expect(described.structuredContent).toMatchObject({
                  schema: "public",
                  name: "invoices",
                });

                const queried = await client.callTool({
                  name: "query",
                  arguments: {
                    source: "app",
                    sql: "select id, total from invoices where id=$1",
                    params: [1],
                  },
                });

                expect(queried.structuredContent).toMatchObject({
                  queryId: "q_7f3a",
                  rows: [
                    [1, "12.3400"],
                    [2, null],
                  ],
                });
                expect(reads).toMatchObject([
                  { sessionId: binding.sessionId, turn, tool: "describe" },
                  { sessionId: binding.sessionId, turn, tool: "query" },
                ]);
                expect(JSON.stringify([sources, described, queried])).not.toContain("://");
              } finally {
                await client.close();
              }
            });
          })
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              EventStore.layerSqlite(":memory:"),
              McpTokens.layer(join(root, "tokens.sqlite")),
              Layer.succeed(
                DataSources,
                DataSources.of({
                  list: () => Effect.succeed([source]),
                  refresh: () => Effect.succeed([source]),
                  resolve: () =>
                    Effect.succeed({
                      source,
                      connection: {
                        hostname: "localhost",
                        port: 5432,
                        database: "db",
                        username: "user",
                        password: Redacted.make("private"),
                        tls: false,
                      },
                      matchUrl: Redacted.make("postgres://user:private@localhost/db"),
                    }),
                  watch: () => Stream.succeed([source]),
                  save: () => Effect.succeed(source),
                  remove: () => Effect.void,
                  label: () => Effect.succeed(source),
                  access: () => Effect.succeed(source),
                })
              ),
              Layer.succeed(
                DataQueries,
                DataQueries.of({
                  describe: (input) => {
                    reads.push(input);

                    return Effect.succeed(table);
                  },
                  query: (input) => {
                    reads.push(input);

                    return Effect.succeed(result);
                  },
                  awaitApproval: () => Effect.succeed({ status: "pending" }),
                  recordOutside: () => Effect.void,
                  watchLog: () => Stream.succeed([]),
                  queryStream: () => Stream.empty,
                  pageLog: () => Effect.succeed({ entries: [], next: null }),
                })
              )
            )
          )
        )
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
