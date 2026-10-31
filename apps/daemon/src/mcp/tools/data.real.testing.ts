/** Child-process acceptance against the production Engine/MCP composition and a disposable DB. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ApprovalDecision, ConstellationId, DomainEvent, TurnItem } from "@polaris/protocol";
import { Effect, Layer, Schema } from "effect";
import { engineServices } from "../../transport/serve.ts";
import { DataSources, DataQueries } from "../../data/index.ts";
import { DataApprovals } from "../../data/approvals.ts";
import { seedDataSessionAt, started } from "../../data/approvals.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { decideSession } from "../../engine/session.ts";
import { useFileSecretsForTests } from "../../secrets/index.ts";
import { mcpHttp } from "../http.ts";
import { McpTokens } from "../tokens.ts";
import { McpBinding } from "../binding.ts";
import { fakeCommands } from "../testing.ts";

const payload = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

useFileSecretsForTests();

const engine = process.argv[2] === "mysql" ? "mysql" : "postgres";

const target =
  process.env[engine === "mysql" ? "POLARIS_DATA_MYSQL_URL" : "POLARIS_DATA_POSTGRES_URL"];

const root = process.env.POLARIS_HOME;

if (!target || !root)
  throw new Error("A disposable local database and isolated POLARIS_HOME are required");

const url = new URL(target);

if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  throw new Error("Only local fixture databases are allowed");

const password = decodeURIComponent(url.password);

const database = decodeURIComponent(url.pathname.slice(1));

const admin = new SQL({
  adapter: engine,
  hostname: url.hostname,
  port: Number(url.port || (engine === "mysql" ? 3306 : 5432)),
  username: decodeURIComponent(url.username),
  password,
  database,
  tls: false,
  max: 1,
});

const prefix = `mx_${crypto.randomUUID().replaceAll("-", "")}`;

const table = engine === "postgres" ? `"${prefix}".invoices` : `\`${prefix}_invoices\``;

const tableName = engine === "postgres" ? `${prefix}.invoices` : `${database}.${prefix}_invoices`;

const quote = engine === "postgres" ? '"' : "`";

try {
  if (engine === "postgres") await admin.unsafe(`CREATE SCHEMA "${prefix}"`);
  await admin.unsafe(`CREATE TABLE ${table} (id integer PRIMARY KEY, amount numeric(12,4))`);
  await admin.unsafe(`INSERT INTO ${table} VALUES (1,12.34),(2,NULL)`);
  writeFileSync(join(root, ".env.local"), `DATABASE_URL=${target}\n`, { mode: 0o600 });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedDataSessionAt(root);
        const sources = yield* DataSources;
        const resolved = yield* sources.resolve({ sessionId: started.session.id, source: "app" });
        const approvals = yield* DataApprovals;
        const store = yield* EventStore;
        yield* approvals.require(started.session.id, resolved.source).pipe(
          Effect.catchTag("DataApprovalRequired", (request) =>
            store.commit({
              commandId: null,
              decide: (model) =>
                Effect.succeed(
                  decideSession(model.sessions.get(started.session.id), {
                    type: "approval.respond",
                    requestId: request.approvalId,
                    decision: ApprovalDecision.cases.Allow.make({
                      remember: true,
                      dataScope: "target",
                    }),
                    resolvedBy: "test",
                  }).events
                ),
            })
          )
        );
        const { origin } = yield* mcpHttp(fakeCommands().commands);

        const token = yield* (yield* McpTokens).issue(
          McpBinding.cases.Plain.make({
            sessionId: started.session.id,
            workspaceId: started.session.workspaceId,
            constellationId: ConstellationId.make("mx-real"),
          })
        );

        const queries = yield* DataQueries;
        let queryId = "";
        yield* Effect.promise(async () => {
          const client = new Client({ name: "mx-real-daemon", version: "1" });

          try {
            // SAFETY: the SDK transport differs only in exactOptionalPropertyTypes sessionId.
            await client.connect(
              new StreamableHTTPClientTransport(new URL(`${origin}/mcp/${token}`)) as Transport
            );
            const listed = await client.callTool({ name: "data_sources", arguments: {} });
            assert.notEqual(listed.isError, true);
            assert(
              Schema.decodeUnknownSync(
                Schema.Struct({
                  sources: Schema.Array(
                    Schema.Struct({ name: Schema.String, engine: Schema.String })
                  ),
                })
              )(listed.structuredContent).sources.some(
                (source) => source.name === "app" && source.engine === engine
              )
            );

            const described = await client.callTool({
              name: "describe",
              arguments: { source: "app", table: tableName, sample: 1 },
            });

            assert.notEqual(described.isError, true);
            assert.equal(
              payload(described.structuredContent).name,
              engine === "postgres" ? "invoices" : `${prefix}_invoices`
            );
            const amount = engine === "postgres" ? "amount::text" : "CAST(amount AS CHAR)";

            const queried = await client.callTool({
              name: "query",
              arguments: {
                source: "app",
                sql: `SELECT id, ${amount} AS amount FROM ${table} WHERE id=${engine === "postgres" ? "$1" : "?"}`,
                params: [1],
                limit: 1,
              },
            });

            assert.notEqual(queried.isError, true);

            const result = Schema.decodeUnknownSync(
              Schema.Struct({
                queryId: Schema.String,
                rows: Schema.Array(Schema.Array(Schema.Json)),
                returned: Schema.Number,
                summary: Schema.String,
              })
            )(queried.structuredContent);

            assert.deepEqual(result.rows, [[1, "12.3400"]]);
            assert.equal(result.returned, 1);
            assert(result.summary.includes("1 row"));
            queryId = result.queryId;

            const secretCell = await client.callTool({
              name: "query",
              arguments: {
                source: "app",
                sql: `SELECT ${engine === "postgres" ? "$1::text" : "CAST(? AS CHAR)"} AS note`,
                params: [password],
              },
            });

            assert.notEqual(secretCell.isError, true);
            assert.deepEqual(payload(secretCell.structuredContent).rows, [["[redacted]"]]);

            const secretError = await client.callTool({
              name: "query",
              arguments: { source: "app", sql: `SELECT ${quote}${password}${quote} FROM ${table}` },
            });

            assert.equal(secretError.isError, true);
            assert.equal(payload(secretError.structuredContent).code, "E-DATA-SQL");

            for (const response of [listed, described, queried, secretCell, secretError]) {
              assert(!JSON.stringify(response).includes(password));
              assert(!JSON.stringify(response).includes("://"));
              assert(!JSON.stringify(response).includes("Revision:"));
            }

            if (engine === "mysql") {
              const refused = await client.callTool({
                name: "query",
                arguments: { source: "app", sql: "SHOW TABLES" },
              });

              assert.equal(payload(refused.structuredContent).code, "E-DATA-SQL");
              assert(
                Schema.decodeUnknownSync(Schema.Struct({ fix: Schema.String }))(
                  refused.structuredContent
                ).fix.includes("describe")
              );
            }
          } finally {
            await client.close();
          }
        });
        const turn = started.turns[0]!.id;
        yield* store.commit({
          commandId: null,
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.TurnItemCompleted.make({
                sessionId: started.session.id,
                turnId: turn,
                subagentId: null,
                item: TurnItem.cases.CommandExecution.make({
                  id: "mx-outside",
                  startedAt: null,
                  command: `/bin/zsh -lc '${engine === "postgres" ? "psql" : "mysql"} "$DATABASE_URL"'`,
                  cwd: root,
                  output: "",
                  exitCode: 0,
                  status: "completed",
                }),
              }),
            ]),
        });

        for (let retry = 0; retry < 100; retry++) {
          const log = yield* queries.pageLog({ sessionId: started.session.id });
          const query = log.entries.find((entry) => entry.id === queryId);
          assert.equal(query?.author.kind, "agent");
          assert.equal(query?.tool, "query");

          if (log.entries.some((entry) => entry.author.kind === "outside")) return;
          yield* Effect.sleep(10);
        }

        throw new Error("Production Engine reactor did not record the outside command");
      })
    ).pipe(
      Effect.provide(
        engineServices.pipe(Layer.provideMerge(McpTokens.layer(join(root, "mcp-test.sqlite"))))
      )
    )
  );
} finally {
  try {
    await admin.unsafe(
      engine === "postgres"
        ? `DROP SCHEMA IF EXISTS "${prefix}" CASCADE`
        : `DROP TABLE IF EXISTS ${table}`
    );
  } finally {
    await admin.close();
  }
}
