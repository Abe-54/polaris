/**
 * Data fixtures for previews, screenshots and tests (Paper "Data (⌘4)", D1–D2): the ledger
 * checkout's three Data Sources, a seven-table schema, 500 invoices and 30 Query Log entries.
 */
import {
  type ApprovalRequest,
  DataSource,
  type DataValue,
  QueryLogEntry,
  type QueryResult,
  RequestId,
  SchemaTree,
  SessionId,
  TableDetail,
  TableSummary,
  TurnId,
} from "@polaris/protocol";
import type { SessionLookup } from "../model/queryLog.ts";

export const FIXTURE_NOW = Date.parse("2026-10-30T18:00:00Z");

export const FIXTURE_SESSIONS = {
  overdue: { id: SessionId.make("s-overdue-totals"), title: "Fix overdue totals" },
  backfill: { id: SessionId.make("s-backfill-currency"), title: "Backfill currency" },
} as const;

/** The two Agent Sessions as the Host's session list has them: Fix overdue totals is Working. */
export const fixtureSessionLookup: SessionLookup = (id) => {
  if (id === FIXTURE_SESSIONS.overdue.id)
    return {
      title: FIXTURE_SESSIONS.overdue.title,
      harness: "claude",
      working: true,
      turn: {
        id: TurnId.make("turn-12"),
        number: 12,
        startedAt: new Date(FIXTURE_NOW - 125 * 60_000).toISOString(),
      },
    };

  if (id === FIXTURE_SESSIONS.backfill.id)
    return {
      title: FIXTURE_SESSIONS.backfill.title,
      harness: "codex",
      working: false,
      turn: {
        id: TurnId.make("turn-5"),
        number: 5,
        startedAt: new Date(FIXTURE_NOW - 3 * 60_000).toISOString(),
      },
    };

  return null;
};

const CHECKOUT = "/Users/lucas/code/ledger.worktrees/overdue-totals";

export const FIXTURE_SOURCES: ReadonlyArray<DataSource> = [
  new DataSource({
    id: "src-app",
    name: "app",
    engine: "postgres",
    version: "16.4",
    locality: "local",
    host: "localhost",
    port: 5432,
    database: "ledger_overdue",
    user: "ledger",
    foundIn: { kind: "env", file: ".env.local", key: "DATABASE_URL" },
    access: "read",
    writes: "ask",
    label: { text: "LOCAL", colour: "none" },
    reachable: true,
  }),
  new DataSource({
    id: "src-ledger-branch",
    name: "ledger",
    engine: "mysql",
    version: "8.0.34-vitess",
    locality: "remote",
    branch: { provider: "planetscale", name: "overdue-totals" },
    host: "aws.connect.psdb.cloud",
    port: 3306,
    database: "ledger",
    user: "overdue-totals-agent",
    foundIn: { kind: "framework", file: "prisma/schema.prisma", key: "datasource db" },
    access: "approved",
    writes: "ask",
    label: { text: "PLANETSCALE · OVERDUE-TOTALS", colour: "tan" },
    reachable: true,
  }),
  new DataSource({
    id: "src-analytics",
    name: "analytics",
    engine: "mysql",
    version: "8.0.36",
    locality: "remote",
    host: "analytics-prod.internal.ledger.dev",
    port: 3306,
    database: "analytics",
    user: "readonly",
    foundIn: { kind: "compose", file: "docker-compose.yml", key: "ANALYTICS_URL" },
    access: "needs-approval",
    writes: "off",
    label: { text: "PRODUCTION", colour: "red" },
    reachable: true,
  }),
];

type Column = TableDetail["columns"][number];

const col = (
  name: string,
  type: string,
  extra: Partial<Pick<Column, "nullable" | "default" | "pk" | "fk">> = {}
): Column => ({
  name,
  type,
  nullable: extra.nullable ?? false,
  default: extra.default ?? null,
  pk: extra.pk ?? false,
  fk: extra.fk ?? null,
});

const fk = (table: string) => ({ schema: "public", table, column: "id" });

const id = col("id", "uuid", { pk: true, default: "gen_random_uuid()" });

const created = col("created_at", "timestamptz", { default: "now()" });

const TABLE_COLUMNS = new Map<string, ReadonlyArray<Column>>(
  Object.entries({
    customers: [id, col("name", "text"), col("email", "text"), col("country", "char(2)"), created],
    invoices: [
      id,
      col("number", "text"),
      col("customer_id", "uuid", { fk: fk("customers") }),
      col("status", "invoice_status"),
      col("total_cents", "int8"),
      col("currency", "char(3)", {
        nullable: true,
        fk: { schema: "public", table: "currencies", column: "code" },
      }),
      col("due_at", "timestamptz"),
      col("paid_at", "timestamptz", { nullable: true }),
    ],
    invoice_items: [
      id,
      col("invoice_id", "uuid", { fk: fk("invoices") }),
      col("description", "text"),
      col("quantity", "int4"),
      col("unit_cents", "int8"),
    ],
    payments: [
      id,
      col("invoice_id", "uuid", { fk: fk("invoices") }),
      col("amount_cents", "int8"),
      col("method", "text"),
      col("received_at", "timestamptz"),
    ],
    currencies: [
      col("code", "char(3)", { pk: true }),
      col("name", "text"),
      col("minor_units", "int2"),
    ],
    users: [id, col("email", "text"), col("role", "text"), created],
    _prisma_migrations: [
      col("id", "varchar(36)", { pk: true }),
      col("migration_name", "varchar(255)"),
      col("finished_at", "timestamptz", { nullable: true }),
      col("applied_steps_count", "int4", { default: "0" }),
    ],
  })
);

const ROW_ESTIMATES = new Map<string, number>(
  Object.entries({
    customers: 2140,
    invoices: 1312,
    invoice_items: 8410,
    payments: 962,
    currencies: 4,
    users: 48,
    _prisma_migrations: 23,
  })
);

export const FIXTURE_TABLES = [...TABLE_COLUMNS.keys()];

export const fixtureColumns = (table: string) =>
  TABLE_COLUMNS.get(table)?.map((c) => ({ name: c.name, type: c.type })) ?? null;

export const FIXTURE_SCHEMA = new SchemaTree({
  loadedAt: new Date(FIXTURE_NOW - 4_000).toISOString(),
  schemas: [
    {
      name: "public",
      tables: FIXTURE_TABLES.map(
        (name) =>
          new TableSummary({
            name,
            rowEstimate: ROW_ESTIMATES.get(name) ?? null,
            columnCount: TABLE_COLUMNS.get(name)?.length ?? 0,
            columns: fixtureColumns(name) ?? [],
          })
      ),
      views: [],
      functions: ["overdue_total(uuid)", "set_updated_at()", "invoice_number()"],
    },
  ],
  truncatedTables: 0,
});

/** A table's detail, with the sample rows given. */
export const fixtureTable = (name: string, sample?: QueryResult): TableDetail | null => {
  const columns = TABLE_COLUMNS.get(name);

  if (columns === undefined) return null;

  const detail = {
    schema: "public",
    name,
    columns,
    indexes: [
      {
        name: `${name}_pkey`,
        columns: [columns[0]?.name ?? "id"],
        unique: true,
        definition: "btree",
      },
      ...(name === "invoices"
        ? [
            {
              name: "invoices_status_due_at_idx",
              columns: ["status", "due_at"],
              unique: false,
              definition: "btree",
            },
          ]
        : []),
    ],
    constraints: columns
      .filter((c) => c.fk !== null)
      .map((c) => ({
        name: `${name}_${c.name}_fkey`,
        kind: "foreign key",
        definition: `FOREIGN KEY (${c.name}) REFERENCES ${c.fk?.table}(${c.fk?.column})`,
      })),
    rowEstimate: ROW_ESTIMATES.get(name) ?? null,
  };

  return new TableDetail(sample === undefined ? detail : { ...detail, sample });
};

/** A small deterministic generator, so screenshots stay the same run to run. */
const seeded = (seed: number) => {
  let state = seed;

  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

    return state / 2_147_483_648;
  };
};

const hex = (next: () => number, n: number) =>
  Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join("");

const uuid = (next: () => number) =>
  `${hex(next, 8)}-${hex(next, 4)}-4${hex(next, 3)}-a${hex(next, 3)}-${hex(next, 12)}`;

const day = (offset: number) => new Date(FIXTURE_NOW + offset * 86_400_000).toISOString();

const CUSTOMER_IDS = Array.from({ length: 24 }, (_, i) => uuid(seeded(1000 + i)));

const STATUSES = ["paid", "paid", "paid", "open", "overdue", "draft"] as const;

const CURRENCIES = ["USD", "USD", "USD", "EUR", "GBP", null] as const;

const pick = <A>(values: ReadonlyArray<A>, next: () => number): A =>
  // SAFETY: values is non-empty and the index is in range.
  values[Math.floor(next() * values.length)] as A;

/** 500 invoices: the table D1 shows, with overdue rows, NULL currencies and NULL paid_at. */
export const FIXTURE_INVOICES: ReadonlyArray<ReadonlyArray<DataValue>> = (() => {
  const next = seeded(42);

  return Array.from({ length: 500 }, (_, i) => {
    const status = pick(STATUSES, next);
    const due = -120 + Math.floor(next() * 150);

    return [
      uuid(next),
      `INV-${String(2000 + i).padStart(4, "0")}`,
      pick(CUSTOMER_IDS, next),
      status,
      String(Math.floor(next() * 400_000) + 500),
      pick(CURRENCIES, next),
      day(due),
      status === "paid" ? day(due - Math.floor(next() * 10)) : null,
    ];
  });
})();

const genericCell = (column: Column, i: number, next: () => number) => {
  if (column.nullable && next() < 0.1) return null;

  if (column.type === "uuid") return column.fk === null ? uuid(next) : pick(CUSTOMER_IDS, next);

  if (column.type === "timestamptz") return day(-Math.floor(next() * 400));

  if (column.type.startsWith("int")) return String(Math.floor(next() * 10_000));

  return `${column.name}_${i + 1}`;
};

const CURRENCY_ROWS = [
  ["USD", "US dollar", 2],
  ["EUR", "Euro", 2],
  ["GBP", "Pound sterling", 2],
  ["JPY", "Yen", 0],
];

/** Every fixture table's rows: invoices and currencies by hand, the rest generated. */
export const fixtureRows = (table: string): ReadonlyArray<ReadonlyArray<DataValue>> | null => {
  if (table === "invoices") return FIXTURE_INVOICES;

  if (table === "currencies") return CURRENCY_ROWS;
  const columns = TABLE_COLUMNS.get(table);

  if (columns === undefined) return null;
  const next = seeded(table.length * 97);
  const count = Math.min(ROW_ESTIMATES.get(table) ?? 0, 60);

  return Array.from({ length: count }, (_, i) => columns.map((c) => genericCell(c, i, next)));
};

const turn = (n: number) => TurnId.make(`turn-${n}`);

const at = (minutesAgo: number) => new Date(FIXTURE_NOW - minutesAgo * 60_000).toISOString();

const app = { id: "src-app", name: "app" };

const branch = { id: "src-ledger-branch", name: "ledger" };

const READS = [
  "select status, count(*), sum(total_cents) from invoices group by 1",
  "select id, total_cents, currency from invoices where status = 'overdue'",
  "select * from customers where id = $1",
  "select count(*) from invoice_items where invoice_id = $1",
  "select code, minor_units from currencies",
  "select * from payments where invoice_id = $1 order by received_at desc",
] as const;

/** The pending write: an agent's update waiting for the user's approval (D3). */
export const FIXTURE_PENDING_WRITE_ID = "q-backfill-write";

export const FIXTURE_PENDING_APPROVAL_ID = RequestId.make("r-backfill-write");

/** 30 entries, oldest first: agent reads, the user's queries, a failure, a `psql` outside Polaris, a pending write. */
export const FIXTURE_QUERY_LOG: ReadonlyArray<QueryLogEntry> = [
  ...Array.from({ length: 24 }, (_, i) => {
    const sql = READS[i % READS.length] ?? READS[0];
    const overdue = i % 3 !== 2;

    return new QueryLogEntry({
      id: `q-${i + 1}`,
      checkout: CHECKOUT,
      source: i % 8 === 7 ? branch : app,
      sql,
      author: {
        kind: "agent",
        sessionId: overdue ? FIXTURE_SESSIONS.overdue.id : FIXTURE_SESSIONS.backfill.id,
        turn: turn(overdue ? 12 : 4),
      },
      tool: "data_query",
      state: "completed",
      rows: (i * 37) % 214,
      elapsedMs: 3 + ((i * 7) % 40),
      at: at(120 - i * 4),
    });
  }),
  new QueryLogEntry({
    id: "q-outside",
    checkout: CHECKOUT,
    source: app,
    sql: "select count(*) from invoices where currency is null",
    author: {
      kind: "outside",
      sessionId: FIXTURE_SESSIONS.backfill.id,
      turn: turn(4),
      command: `psql $DATABASE_URL -c "select count(*) from invoices where currency is null"`,
    },
    state: "completed",
    at: at(14),
  }),
  new QueryLogEntry({
    id: "q-user-1",
    checkout: CHECKOUT,
    source: app,
    sql: "select * from invoices where status = 'overdue' and due_at < now() - interval '30 days'",
    author: { kind: "user" },
    state: "completed",
    rows: 214,
    elapsedMs: 9,
    at: at(8),
  }),
  new QueryLogEntry({
    id: "q-user-2",
    checkout: CHECKOUT,
    source: app,
    sql: "select * from invoices where currency is null",
    author: { kind: "user" },
    state: "completed",
    rows: 38,
    elapsedMs: 4,
    at: at(6),
  }),
  new QueryLogEntry({
    id: "q-failed",
    checkout: CHECKOUT,
    source: app,
    sql: "select total from invoices",
    author: { kind: "agent", sessionId: FIXTURE_SESSIONS.overdue.id, turn: turn(12) },
    tool: "data_query",
    state: "failed",
    error: 'column "total" does not exist',
    elapsedMs: 2,
    at: at(5),
  }),
  new QueryLogEntry({
    id: "q-branch-read",
    checkout: CHECKOUT,
    source: branch,
    sql: "select count(*) from invoices where status = 'overdue'",
    author: { kind: "agent", sessionId: FIXTURE_SESSIONS.overdue.id, turn: turn(12) },
    tool: "data_query",
    state: "completed",
    rows: 1,
    elapsedMs: 31,
    at: at(2),
  }),
  new QueryLogEntry({
    id: FIXTURE_PENDING_WRITE_ID,
    checkout: CHECKOUT,
    source: app,
    sql: "update invoices set currency = 'USD' where currency is null",
    author: { kind: "agent", sessionId: FIXTURE_SESSIONS.backfill.id, turn: turn(5) },
    tool: "data_query",
    state: "waiting-approval",
    approval: { id: FIXTURE_PENDING_APPROVAL_ID, status: "pending" },
    at: at(0),
  }),
];

const approvalRequest = {
  id: RequestId.make("r-analytics-read"),
  sessionId: FIXTURE_SESSIONS.backfill.id,
  turnId: TurnId.make("turn-5"),
  kind: "tool",
  title: "Read analytics",
  detail: null,
  options: [],
  questions: [],
  placeholder: null,
  expiresAt: null,
  openedAt: new Date(FIXTURE_NOW - 40_000).toISOString(),
  dataSource: {
    sourceId: "src-analytics",
    sourceName: "analytics",
    engine: "mysql",
    host: "aws.connect.psdb.cloud",
    port: 3306,
    database: "analytics",
    user: "u_7kq2xmz4p1",
    branch: { provider: "planetscale", name: "backfill-currency" },
  },
} as const;

/** A Data Source Approval as X's event carries it, until the protocol has `dataSource`. */
export const FIXTURE_DATA_APPROVAL: ApprovalRequest = approvalRequest;
