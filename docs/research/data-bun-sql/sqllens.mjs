import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { connect, emit, engine } from "./report.mjs";

const require = createRequire(join(process.env.SPIKE_LSP_ROOT, "package.json"));
const load = specifier => import(pathToFileURL(require.resolve(specifier)).href);
const { Schema, CallbackSchema } = await load("sqllens");
const { startServer } = await load("sqllens-language-server");
const { createConnection, ProposedFeatures } = await load("vscode-languageserver/node");
const sql = connect();
const statement = engine === "postgres"
  ? "SELECT table_schema,table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position"
  : "SELECT TABLE_SCHEMA AS table_schema,TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION";
const rows = await sql.unsafe(statement);
const mapping = {};
for (const row of rows) {
  const schema = mapping[row.table_schema] ??= {};
  const table = schema[row.table_name] ??= {};
  table[row.column_name] = row.data_type;
}
await checkLsp(new Schema(mapping), "enumerated-live-schema");
const cache = new Map();
const lazy = new CallbackSchema({
  resolve: parts => cache.get(parts.at(-1)),
  fetch: async missing => {
    for (const parts of missing) {
      const table = parts.at(-1);
      const columns = rows.filter(row => row.table_name === table).map(row => ({ name: row.column_name, type: row.data_type }));
      if (columns.length) cache.set(table, columns);
    }
  },
});
const before = lazy.tables(engine);
lazy.columnsFor(["t_0"], engine);
await lazy.prime();
emit("sqllens-lazy-enumeration", { before, after: lazy.tables(engine), version: lazy.version });
await sql.close();

async function checkLsp(schema, label) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = createConnection(ProposedFeatures.all, input, output);
  const client = createConnection(ProposedFeatures.all, output, input);
  const diagnostics = [];
  client.onNotification("textDocument/publishDiagnostics", params => diagnostics.push(params));
  client.onRequest("workspace/configuration", () => []);
  startServer(server, { schema, userConfigPath: "/tmp/polaris-spike-no-user-config.json" });
  client.listen();
  try {
    const initialized = await client.sendRequest("initialize", { processId: process.pid, rootUri: "file:///tmp/polaris-spike-lsp", capabilities: {} });
    await client.sendNotification("initialized", {});
    const requests = [
      { sql: "SELECT * FROM t_", offset: 16, expected: "t_0" },
      { sql: "SELECT p. FROM t_0 p", offset: 9, expected: "parent_id" },
    ];
    for (const [n, request] of requests.entries()) {
      const uri = `file:///tmp/polaris-spike-lsp/probe-${n}.sql`;
      await client.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: `sql-${engine}`, version: 1, text: request.sql } });
      const items = await client.sendRequest("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: request.offset } });
      const labels = items.map(item => item.label);
      emit(`sqllens-${label}`, { statements: [statement], sql: request.sql, offset: request.offset, resultCount: items.length, sample: items.slice(0, 5), expected: request.expected, found: labels.includes(request.expected), completionProvider: initialized.capabilities.completionProvider });
      assert.ok(labels.includes(request.expected), `Missing ${request.expected}`);
    }
    await client.sendRequest("shutdown");
  } finally {
    client.dispose();
    server.dispose();
    input.destroy();
    output.destroy();
  }
}
