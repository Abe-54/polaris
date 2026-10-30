/** Opt-in real PostgreSQL, discovery, execution and MCP HTTP; owns only its random schema. */
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AgentSession, DomainEvent } from "@polaris/protocol";
import { Effect, Layer, Schema, Stream } from "effect";
import { DataQueries, DataSources } from "../../data/index.ts";
import { session, send } from "../../constellation/delivery/testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { HostSecrets } from "../../secrets/index.ts";
import { shortTemp } from "../../platform/testing.ts";
import { McpTokens } from "../tokens.ts";
import { mcpHttp } from "../http.ts";
import { fakeCommands } from "../testing.ts";
import { plainBinding } from "./data.testing.ts";

const postgresUrl = process.env.POLARIS_DATA_POSTGRES_URL;

if (postgresUrl === undefined)
  console.info(
    "Skipping real MCP/Postgres Data test: set POLARIS_DATA_POSTGRES_URL to a disposable local Postgres."
  );

const Sources = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({ name: Schema.String, engine: Schema.String, database: Schema.String })
  ),
});

const Result = Schema.Struct({
  queryId: Schema.String,
  rows: Schema.Array(Schema.Array(Schema.Json)),
});

test.skipIf(postgresUrl === undefined)(
  "Data tools through real MCP HTTP discover, describe, sample and query local Postgres",
  async () => {
    const url = new URL(postgresUrl!);

    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("The fixture requires a local Postgres");

    const admin = new SQL({
      adapter: "postgres",
      hostname: url.hostname,
      port: Number(url.port || 5432),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      tls: false,
      max: 1,
    });

    const schema = `mcp_${crypto.randomUUID().replaceAll("-", "")}`;
    const root = mkdtempSync(shortTemp("pl-m-pg-"));

    try {
      await admin.unsafe(`CREATE SCHEMA "${schema}"`);
      await admin.unsafe(
        `CREATE TABLE "${schema}".invoices (id integer PRIMARY KEY, amount numeric(12,4))`
      );
      await admin.unsafe(`INSERT INTO "${schema}".invoices VALUES (1, 12.34), (2, NULL)`);
      writeFileSync(join(root, ".env.local"), `DATABASE_URL=${postgresUrl}\n`, { mode: 0o600 });

      const services = Layer.mergeAll(DataSources.layer, DataQueries.layer);

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* EventStore;

            const created = Schema.decodeUnknownSync(AgentSession)({
              ...Schema.encodeSync(AgentSession)(session(plainBinding.sessionId)),
              cwd: root,
            });

            yield* store.commit({
              commandId: null,
              decide: () =>
                Effect.succeed([DomainEvent.cases.SessionCreated.make({ session: created })]),
            });
            yield* send(plainBinding.sessionId, "Read invoices");
            const turn = (yield* store.model).sessions.get(plainBinding.sessionId)!.turns[0]!.id;
            const { origin } = yield* mcpHttp(fakeCommands().commands);
            const tokens = yield* McpTokens;
            const token = yield* tokens.issue(plainBinding);
            const queries = yield* DataQueries;
            const client = new Client({ name: "data-postgres-test", version: "1" });
            let queryId = "";

            yield* Effect.promise(async () => {
              try {
                // SAFETY: the SDK's optional sessionId differs only under exactOptionalPropertyTypes.
                await client.connect(
                  new StreamableHTTPClientTransport(new URL(`${origin}/mcp/${token}`)) as Transport
                );
                const listed = await client.callTool({ name: "data_sources", arguments: {} });
                expect(listed.isError).not.toBe(true);
                const sources = Schema.decodeUnknownSync(Sources)(listed.structuredContent).sources;

                const source = sources.find(
                  (source) =>
                    source.engine === "postgres" &&
                    source.database === decodeURIComponent(url.pathname.slice(1))
                );

                if (source === undefined)
                  throw new Error("The fixture database was not discovered");

                const described = await client.callTool({
                  name: "describe",
                  arguments: { source: source.name, table: `${schema}.invoices`, sample: 1 },
                });

                expect(described.isError).not.toBe(true);
                expect(described.structuredContent).toMatchObject({
                  schema,
                  name: "invoices",
                  columns: [{ name: "id", pk: true }, { name: "amount" }],
                });

                const queried = await client.callTool({
                  name: "query",
                  arguments: {
                    source: source.name,
                    sql: `SELECT id, amount::text FROM "${schema}".invoices WHERE id=$1`,
                    params: [1],
                    limit: 1,
                  },
                });

                expect(queried.isError).not.toBe(true);
                const result = Schema.decodeUnknownSync(Result)(queried.structuredContent);
                expect(result.rows).toEqual([[1, "12.3400"]]);
                queryId = result.queryId;
                expect(JSON.stringify([listed, described, queried])).not.toContain("://");

                if (url.password.length >= 4)
                  expect(JSON.stringify([listed, described, queried])).not.toContain(
                    decodeURIComponent(url.password)
                  );
              } finally {
                await client.close();
              }
            });

            const log = yield* queries
              .watchLog({ sessionId: plainBinding.sessionId })
              .pipe(Stream.take(1), Stream.runCollect);

            expect(log.flat().find((entry) => entry.id === queryId)).toMatchObject({
              author: { kind: "agent", sessionId: plainBinding.sessionId, turn },
              tool: "query",
            });
            expect(log.flat().some((entry) => entry.tool === "describe")).toBe(true);
          })
        ).pipe(
          Effect.provide(services),
          Effect.provide(
            Layer.mergeAll(
              EventStore.layerSqlite(":memory:"),
              McpTokens.layer(join(root, "tokens.sqlite")),
              HostSecrets.memory()
            )
          )
        )
      );
    } finally {
      try {
        await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  60_000
);
