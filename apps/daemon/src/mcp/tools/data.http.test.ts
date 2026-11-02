import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DataSource, DomainEvent, RequestId, type TurnId } from "@polaris/protocol";
import { Effect, Layer, Redacted, Stream, Schema } from "effect";
import { DataApprovalRequired } from "../../data/approvalRequired.ts";
import { DataSources, DataQueries } from "../../data/index.ts";
import { session, send } from "../../constellation/delivery/testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { McpTokens } from "../tokens.ts";
import { mcpHttp } from "../http.ts";
import { fakeCommands } from "../testing.ts";
import { bindings, result, source, sourceFields, table } from "./data.testing.ts";

for (const binding of bindings)
  test(`${binding._tag} Data tools over real MCP HTTP bind the current Turn`, async () => {
    const root = newTempDir("pl-m-data-", { short: true });
    const reads: Array<{ sessionId: string; turn?: TurnId; tool?: string }> = [];
    let waitStarted!: () => void;

    const waiting = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });

    let interrupted = false;
    let waitCalls = 0;

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

                const visible = Schema.decodeUnknownSync(
                  Schema.Struct({ sources: Schema.Array(Schema.Struct({ name: Schema.String })) })
                )(sources.structuredContent).sources.map((source) => source.name);

                expect(visible).toContain("app");
                expect(visible).toContain("broken");

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

                const post = (body: Schema.Json) =>
                  fetch(`${origin}/mcp/${token}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                  });

                const cancellable = post({
                  jsonrpc: "2.0",
                  id: "cancel-me",
                  method: "tools/call",
                  params: { name: "query", arguments: { source: "app", sql: "wait" } },
                });

                await waiting;

                const cancelled = await post({
                  jsonrpc: "2.0",
                  method: "notifications/cancelled",
                  params: { requestId: "cancel-me" },
                });

                expect(cancelled.status).toBe(202);
                await cancellable;
                expect(interrupted).toBe(true);
                expect(waitCalls).toBe(1);
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
                  list: () =>
                    Effect.succeed([
                      source,
                      new DataSource({ ...sourceFields, id: "bad", name: "broken" }),
                    ]),
                  refresh: () => Effect.succeed([source]),
                  resolve: (input) => {
                    if (input.source !== "app")
                      throw new Error("Unrelated broken source must not be resolved");

                    return Effect.succeed({
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
                    });
                  },
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
                  execute: () => Effect.die("Unexpected execute"),
                  commitEdits: () => Effect.die("Unexpected commit"),
                  describe: (input) => {
                    reads.push(input);

                    return Effect.succeed(table);
                  },
                  query: (input) => {
                    reads.push(input);

                    if (input.sql === "wait") {
                      waitCalls++;

                      return Effect.fail(
                        new DataApprovalRequired({
                          approvalId: RequestId.make("cancel-approval"),
                          sourceId: source.id,
                          sourceName: source.name,
                        })
                      );
                    }

                    return Effect.succeed(result);
                  },
                  awaitApproval: () =>
                    Effect.gen(function* () {
                      waitStarted();

                      return yield* Effect.never;
                    }).pipe(
                      Effect.onInterrupt(() =>
                        Effect.sync(() => {
                          interrupted = true;
                        })
                      )
                    ),
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
      removeTempDir(root);
    }
  });
