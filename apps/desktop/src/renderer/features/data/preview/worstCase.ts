/**
 * Worst-case Data for screenshots (product-design, Verification): 11 Data Sources across every
 * label and access, one with 400 tables named up to 60 characters, and a 60-entry Query Log.
 */
import { DataSource, QueryLogEntry, SchemaTree, TableSummary, TurnId } from "@polaris/protocol";
import type { DataApi, TableChange } from "../data/api.ts";
import { fixtureDataApi } from "./fixtureApi.ts";
import {
  FIXTURE_NOW,
  FIXTURE_QUERY_LOG,
  FIXTURE_SCHEMA,
  FIXTURE_SESSIONS,
  FIXTURE_SOURCES,
} from "./fixtures.ts";

type Seed = Pick<DataSource, "name" | "engine" | "locality" | "host" | "access" | "label"> &
  Partial<Pick<DataSource, "branch" | "reachable" | "error" | "writes">>;

const source = (seed: Seed) =>
  new DataSource({
    id: `src-${seed.name}`,
    version: seed.engine === "postgres" ? "17.2" : "8.4.3",
    port: seed.engine === "postgres" ? 5432 : 3306,
    database: seed.name.replaceAll("-", "_"),
    user: "app",
    foundIn: { kind: "env", file: ".env.local", key: `${seed.name.toUpperCase()}_URL` },
    writes: "ask",
    reachable: true,
    ...seed,
  });

/** The long-named replica holding the 400 tables. */
const REPLICA = source({
  name: "warehouse-reporting-replica-eu-central-1-read-only",
  engine: "postgres",
  locality: "remote",
  host: "warehouse-reporting-replica.eu-central-1.rds.amazonaws.com",
  access: "approved",
  writes: "off",
  label: { text: "REPORTING REPLICA · EU CENTRAL", colour: "blue" },
});

const SEEDS: ReadonlyArray<Seed> = [
  {
    name: "billing",
    engine: "postgres",
    locality: "local",
    host: "localhost",
    access: "read",
    label: { text: "LOCAL", colour: "green" },
  },
  {
    name: "queue",
    engine: "mysql",
    locality: "local",
    host: "127.0.0.1",
    access: "read",
    label: { text: "", colour: "grey" },
  },
  {
    name: "search",
    engine: "postgres",
    locality: "local",
    host: "localhost",
    access: "read",
    label: { text: "LOCAL", colour: "none" },
    reachable: false,
    error: "connection refused",
  },
  {
    name: "neon-preview",
    engine: "postgres",
    locality: "remote",
    host: "ep-cool-dawn-123456.us-east-2.aws.neon.tech",
    access: "needs-approval",
    branch: { provider: "neon", name: "preview/eng-212-overdue-totals-backfill" },
    label: { text: "", colour: "tan" },
  },
  {
    name: "legacy",
    engine: "mysql",
    locality: "remote",
    host: "legacy-db.internal",
    access: "denied",
    label: { text: "LEGACY", colour: "red" },
  },
  {
    name: "events",
    engine: "mysql",
    locality: "remote",
    host: "events.internal",
    access: "approved",
    label: { text: "STAGING", colour: "tan" },
  },
  {
    name: "auth",
    engine: "postgres",
    locality: "local",
    host: "localhost",
    access: "read",
    label: { text: "LOCAL", colour: "none" },
  },
];

/** The replica, the ledger's three, then seven more: 11 in all. */
export const WORST_SOURCES: ReadonlyArray<DataSource> = [
  REPLICA,
  ...FIXTURE_SOURCES,
  ...SEEDS.map(source),
];

const WORDS = [
  "invoice",
  "customer",
  "ledger_entry",
  "payment_attempt",
  "subscription",
  "webhook_delivery",
  "audit",
];

/** 400 tables; every seventh is padded to 60 characters. */
const longName = (i: number) => {
  const base = `${WORDS[i % WORDS.length]}_${String(i).padStart(3, "0")}`;

  return i % 7 === 0
    ? `${base}_historical_snapshot_partitioned_by_month`.padEnd(60, "x").slice(0, 60)
    : base;
};

export const WORST_SCHEMA = new SchemaTree({
  schemas: [
    {
      name: "public",
      tables: Array.from(
        { length: 400 },
        (_, i) =>
          new TableSummary({
            name: longName(i),
            rowEstimate: i % 11 === 0 ? null : (i * 7919) % 9_800_000,
            columnCount: 6,
          })
      ),
      views: [
        new TableSummary({
          name: "overdue_invoices_by_customer_and_month_v",
          rowEstimate: null,
          columnCount: 4,
        }),
      ],
      functions: ["overdue_total(uuid)", "set_updated_at()"],
    },
    ...FIXTURE_SCHEMA.schemas.map((s) => ({ ...s, name: "billing" })),
  ],
  truncatedTables: 12,
});

const WORST_CHANGES: ReadonlyArray<TableChange> = [
  { source: REPLICA.name, schema: "public", table: longName(0), change: "added" },
  { source: REPLICA.name, schema: "public", table: longName(1), change: "modified" },
];

const LONG_SQL =
  "select c.id, c.name, sum(i.total_cents) as overdue_cents, count(*) filter (where i.paid_at is null) from customers c join invoices i on i.customer_id = c.id group by 1, 2 order by 3 desc";

/** The ledger's log plus 30 long reads, and one read still running on invoices. */
export const WORST_QUERY_LOG: ReadonlyArray<QueryLogEntry> = [
  ...Array.from(
    { length: 30 },
    (_, i) =>
      new QueryLogEntry({
        id: `q-long-${i}`,
        checkout: "/Users/lucas/code/ledger.worktrees/overdue-totals",
        source: { id: "src-app", name: "app" },
        sql: LONG_SQL,
        author: {
          kind: "agent",
          sessionId: FIXTURE_SESSIONS.overdue.id,
          turn: TurnId.make("turn-11"),
        },
        tool: "data_query",
        rows: 1_204_311 + i,
        elapsedMs: 1830,
        at: new Date(FIXTURE_NOW - (300 + i) * 60_000).toISOString(),
      })
  ),
  ...FIXTURE_QUERY_LOG,
  new QueryLogEntry({
    id: "q-running",
    checkout: "/Users/lucas/code/ledger.worktrees/overdue-totals",
    source: { id: "src-app", name: "app" },
    sql: "select id, total_cents, currency from invoices where status = 'overdue'",
    author: { kind: "agent", sessionId: FIXTURE_SESSIONS.overdue.id, turn: TurnId.make("turn-12") },
    tool: "data_query",
    at: new Date(FIXTURE_NOW).toISOString(),
  }),
];

/** The worst case behind the fixture api: the 400-table schema for the long-named replica. */
export const worstCaseDataApi = (): DataApi =>
  fixtureDataApi({
    sources: WORST_SOURCES,
    queryLog: WORST_QUERY_LOG,
    tableChanges: WORST_CHANGES,
    schema: (name) => (name === REPLICA.name ? WORST_SCHEMA : FIXTURE_SCHEMA),
  });
