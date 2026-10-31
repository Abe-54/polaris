import {
  DataSource,
  QueryResult,
  TableDetail,
  SchemaTree,
  SessionId,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect } from "effect";
import { McpBinding } from "../binding.ts";
import { fakeCommands, leadBinding, workerBinding } from "../testing.ts";
import { unavailableSessions } from "../sessions/index.ts";
import type { DataSessionTools } from "../sessions/data.ts";
import { attachSessionTools, constellationTools } from "./index.ts";

export const sourceFields: ConstructorParameters<typeof DataSource>[0] = {
  id: "s-app",
  name: "app",
  engine: "postgres",
  version: "16.4",
  locality: "local",
  host: "localhost",
  port: 5432,
  database: "ledger",
  user: "owner",
  foundIn: { kind: "env", file: ".env.local", key: "DATABASE_URL" },
  access: "read",
  writes: "ask",
  label: { text: "Local", colour: "none" },
  reachable: true,
};

export const source = new DataSource(sourceFields);

export const resultFields: ConstructorParameters<typeof QueryResult>[0] = {
  queryId: "q_7f3a",
  columns: [
    { name: "id", type: "int4" },
    { name: "total", type: "numeric" },
  ],
  rows: [
    [1, "12.3400"],
    [2, null],
  ],
  rowCount: 2,
  returned: 2,
  truncated: false,
  elapsedMs: 34,
};

export const result = new QueryResult(resultFields);

export const tableFields: ConstructorParameters<typeof TableDetail>[0] = {
  schema: "public",
  name: "invoices",
  rowEstimate: 18402,
  columns: [
    { name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()", pk: true, fk: null },
    {
      name: "customer_id",
      type: "uuid",
      nullable: false,
      default: null,
      pk: false,
      fk: { schema: "public", table: "customers", column: "id" },
    },
    { name: "total_cents", type: "bigint", nullable: false, default: null, pk: false, fk: null },
    { name: "due_at", type: "timestamptz", nullable: true, default: null, pk: false, fk: null },
  ],
  indexes: [
    { name: "invoices_pkey", columns: ["id"], unique: true, definition: "PRIMARY KEY (id)" },
    {
      name: "invoices_due_at_idx",
      columns: ["due_at"],
      unique: false,
      definition: "CREATE INDEX invoices_due_at_idx ON invoices(due_at)",
    },
  ],
  constraints: [],
};

export const table = new TableDetail(tableFields);

export const tree = new SchemaTree({
  loadedAt: "2026-10-30T00:00:00Z",
  schemas: [
    {
      name: "public",
      tables: [
        { name: "invoices", rowEstimate: 18402, columnCount: 4, columns: tableFields.columns },
      ],
      views: [
        {
          name: "overdue",
          rowEstimate: null,
          columnCount: 2,
          columns: tableFields.columns.slice(0, 2),
        },
      ],
      functions: ["invoice_total"],
    },
  ],
  truncatedTables: 0,
});

export const plainBinding = McpBinding.cases.Plain.make({
  sessionId: SessionId.make("plain-1"),
  constellationId: leadBinding.constellationId,
  workspaceId: WorkspaceId.make("workspace"),
});

export const bindings = [plainBinding, leadBinding, workerBinding];

export const toolsWithData = (
  data: Partial<DataSessionTools> = {},
  binding: McpBinding = plainBinding
) => {
  const commands = fakeCommands().commands;
  attachSessionTools(commands, {
    ...unavailableSessions,
    data: {
      sources: () => Effect.succeed({ checkout: "~/code/ledger", sources: [source] }),
      describe: (input) => Effect.succeed(input.table === undefined ? tree : table),
      execute: () => Effect.die("Unexpected execute"),
      query: () => Effect.succeed(result),
      credentials: () => Effect.succeed([]),
      awaitApproval: () => Effect.succeed({ status: "approved" }),
      ...data,
    },
  });
  const tools = constellationTools(binding, commands);

  return (name: string) => {
    const tool = tools.find((tool) => tool.name === name);

    if (tool === undefined) throw new Error(`Missing ${name}`);

    return tool;
  };
};
