/**
 * Review's Data section on fixtures (Paper D4, ENG-645): `#review/session-data` (a Prisma
 * migration adds `currencies` and links `invoices`), `-worst` (240 tables, long names,
 * truncated, every baseline, caveat, failure and column detail, triggers and views, wide tables),
 * `-pending`, `-unavailable`, `-pruned` (history dropped by retention) and `-unsupported`.
 */
import {
  type DataSchemaDiff,
  SCHEMA_DIFF_CAPABILITY,
  type SchemaSourceDiff,
  type SchemaTableDiff,
  type SessionId,
  TurnId,
} from "@polaris/protocol";
import type { HostView } from "../../../../shared/api.ts";
import { fixtureDataApi } from "../../data/preview/fixtureApi.ts";

export const isSchemaScene = (scene: string) => scene.startsWith("session-data");

const file = (path: string, lines: ReadonlyArray<string>) =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n");

const MIGRATION = file("prisma/migrations/20261030120000_currencies/migration.sql", [
  "CREATE TABLE currencies (code char(3) PRIMARY KEY, name text NOT NULL);",
  "ALTER TABLE invoices ADD COLUMN currency char(3);",
  "ALTER TABLE invoices ADD CONSTRAINT invoices_currency_fkey",
  "  FOREIGN KEY (currency) REFERENCES currencies(code);",
  "CREATE INDEX invoices_currency_idx ON invoices (currency);",
]);

/** The migration leads Turn 23's files, so the Data section follows it. */
export const schemaPatch = (scene: string, turnId: string, patch: string) =>
  isSchemaScene(scene) && turnId === "t23" ? `${MIGRATION}\n${patch}` : patch;

/** `-unsupported`: the local Host as an older Daemon without `data.schemaDiff`. */
export const schemaHosts = (scene: string, hosts: ReadonlyArray<HostView>) =>
  scene === "session-data-unsupported"
    ? hosts.map((h) =>
        h.key === "local"
          ? {
              ...h,
              status: {
                ...h.status,
                capabilities: h.status.capabilities.filter((c) => c !== SCHEMA_DIFF_CAPABILITY),
              },
            }
          : h
      )
    : hosts;

const id = (name: string, schema = "public") => ({ schema, name });

type ColumnMore = Partial<{
  nullable: boolean;
  pk: boolean;
  default: string;
  fk: string;
  generated: string;
  collation: string;
  extra: string;
  fingerprint: string;
}>;

const column = (name: string, type: string, more: ColumnMore = {}) => ({
  name,
  type,
  nullable: more.nullable ?? false,
  default: more.default ?? null,
  ...(more.generated === undefined ? undefined : { generated: more.generated }),
  ...(more.collation === undefined ? undefined : { collation: more.collation }),
  ...(more.extra === undefined ? undefined : { extra: more.extra }),
  ...(more.fingerprint === undefined ? undefined : { fingerprint: more.fingerprint }),
  pk: more.pk ?? false,
  fk:
    more.fk === undefined
      ? null
      : {
          schema: "public",
          table: more.fk.split(".")[0] ?? "",
          column: more.fk.split(".")[1] ?? "",
        },
});

type Rows = SchemaTableDiff["rows"];

const exact = (value: number, split?: { agent: number; user?: number }): Rows => {
  if (split === undefined) return { kind: "exact", value };

  return split.user === undefined
    ? { kind: "exact", value, agent: split.agent }
    : { kind: "exact", value, agent: split.agent, user: split.user };
};

const UNKNOWN: Rows = { kind: "unknown", value: null };

const estimate = (value: number): Rows => ({ kind: "estimate", value });

const added = (name: string, rows: Rows): SchemaTableDiff => ({
  kind: "added",
  before: null,
  after: id(name),
  columns: [
    { name: "code", before: null, after: column("code", "char(3)", { pk: true }) },
    { name: "name", before: null, after: column("name", "text") },
  ],
  indexes: [],
  constraints: [],
  rows,
});

const INVOICES: SchemaTableDiff = {
  kind: "changed",
  before: id("invoices"),
  after: id("invoices"),
  columns: [
    {
      name: "currency",
      before: null,
      after: column("currency", "char(3)", { nullable: true, fk: "currencies.code" }),
    },
    {
      name: "total_cents",
      before: column("total_cents", "integer", { nullable: true }),
      after: column("total_cents", "bigint", { default: "0" }),
    },
  ],
  indexes: [
    {
      name: "invoices_currency_idx",
      before: null,
      after: {
        name: "invoices_currency_idx",
        columns: ["currency"],
        unique: false,
        definition: "CREATE INDEX invoices_currency_idx ON invoices (currency)",
      },
    },
  ],
  constraints: [
    {
      name: "invoices_currency_fkey",
      before: null,
      after: {
        name: "invoices_currency_fkey",
        kind: "foreign key",
        definition: "FOREIGN KEY (currency) REFERENCES currencies(code)",
      },
    },
  ],
  rows: exact(214, { agent: 200, user: 14 }),
};

const RENAMED: SchemaTableDiff = {
  kind: "renamed",
  before: id("clients"),
  after: id("customers"),
  columns: [],
  indexes: [],
  constraints: [],
  rows: estimate(1200),
};

const REMOVED: SchemaTableDiff = {
  kind: "removed",
  before: id("legacy_rates"),
  after: null,
  columns: [{ name: "rate", before: column("rate", "numeric(10,4)"), after: null }],
  indexes: [],
  constraints: [],
  rows: UNKNOWN,
};

const TRIGGER_BEFORE =
  "CREATE TRIGGER orders_audit AFTER UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION audit_order_change('orders', 'update')";

const VIEW_AFTER = [
  " SELECT o.id,",
  "    o.customer_id,",
  "    sum(l.quantity * l.unit_price_cents) AS total_cents",
  "   FROM orders o",
  "     JOIN order_lines l ON l.order_id = o.id",
  "  WHERE o.status <> 'cancelled'::text",
  "  GROUP BY o.id, o.customer_id;",
].join("\n");

/** A wide table with every column detail, a trigger, a view and a fingerprint-only change. */
const ORDERS: SchemaTableDiff = {
  kind: "changed",
  before: id("orders"),
  after: id("orders"),
  detailsTruncated: true,
  columns: [
    {
      name: "total_cents",
      before: column("total_cents", "bigint", { generated: "subtotal_cents + tax_cents" }),
      after: column("total_cents", "bigint", {
        generated: "subtotal_cents + tax_cents - discount_cents",
      }),
    },
    {
      name: "reference",
      before: column("reference", "varchar(64)", { collation: "utf8mb4_general_ci" }),
      after: column("reference", "varchar(64)", { collation: "utf8mb4_bin" }),
    },
    {
      name: "updated_at",
      before: column("updated_at", "timestamp"),
      after: column("updated_at", "timestamp", { extra: "on update CURRENT_TIMESTAMP" }),
    },
    {
      name: "status",
      before: column("status", "text", { default: "[redacted]", fingerprint: "a1" }),
      after: column("status", "text", { default: "[redacted]", fingerprint: "b2" }),
    },
  ],
  indexes: [],
  constraints: [
    {
      name: "orders_audit",
      before: { name: "orders_audit", kind: "trigger", definition: TRIGGER_BEFORE },
      after: {
        name: "orders_audit",
        kind: "trigger",
        definition: TRIGGER_BEFORE.replace("AFTER UPDATE", "AFTER INSERT OR UPDATE"),
      },
    },
    {
      name: "view",
      before: null,
      after: { name: "view", kind: "view", definition: VIEW_AFTER },
    },
    {
      name: "orders_total_check",
      before: { name: "orders_total_check", kind: "c", definition: "CHECK (total_cents > 0)" },
      after: { name: "orders_total_check", kind: "c", definition: "CHECK (total_cents >= 0)" },
    },
    {
      name: "row_security",
      before: { name: "row_security", kind: "security", definition: "false:false" },
      after: { name: "row_security", kind: "security", definition: "true:true" },
    },
  ],
  rows: { kind: "unknown", value: null, agent: 1_204_331, user: 2 },
};

const source = (
  name: string,
  tables: ReadonlyArray<SchemaTableDiff>,
  more: Partial<SchemaSourceDiff> = {}
): SchemaSourceDiff => ({
  source: { id: `src-${name}`, name },
  status: "complete",
  baseline: "turn-start",
  beforeAt: "2026-10-30T12:00:00.000Z",
  afterAt: "2026-10-30T12:04:00.000Z",
  truncated: false,
  tables,
  ...more,
});

const LONG =
  "household_income_eligibility_determinations_by_county_and_program_year_with_overrides";

/** 240 tables: every kind, long unbreakable names, and each rows kind. */
const manyTables = (): ReadonlyArray<SchemaTableDiff> =>
  Array.from({ length: 240 }, (_, n): SchemaTableDiff => {
    const name = n % 7 === 0 ? `${LONG}_${n}` : `table_${String(n).padStart(3, "0")}`;
    const rows = [exact(n * 3), estimate(-n), UNKNOWN][n % 3] ?? UNKNOWN;

    if (n % 4 === 0) return { ...added(name, rows), after: id(name, "billing") };

    if (n % 4 === 1) return { ...INVOICES, before: id(name), after: id(name), rows };

    if (n % 4 === 2) return { ...RENAMED, before: id(`${name}_old`), after: id(name), rows };

    return { ...REMOVED, before: id(name), rows };
  });

/** Two hours before the fixtures' Turn ended: a baseline carried from turn 21. */
const CARRIED = {
  baseline: "first-use" as const,
  baselineTurn: TurnId.make("t21"),
  baselineCapturedAt: "2026-10-30T10:04:00.000Z",
};

const sourcesFor = (scene: string): ReadonlyArray<SchemaSourceDiff> => {
  if (scene === "session-data-pending")
    return [source("app", [], { status: "pending", afterAt: null })];

  if (scene === "session-data-unavailable")
    return [
      source("app", [], { status: "unavailable", beforeAt: null, errorCode: "E-DATA-UNREACHABLE" }),
    ];

  if (scene === "session-data-pruned") return [];

  if (scene === "session-data-worst")
    return [
      source(`${LONG}_replica`, [ORDERS, ...manyTables()], {
        truncated: true,
        concurrent: true,
        capturedLate: true,
        baseline: "previous-turn-end",
      }),
      source("staging", [{ ...INVOICES, rows: UNKNOWN }], CARRIED),
      source("ledger", [ORDERS], { baseline: "first-use", capturedLate: true }),
      source("analytics", [], { status: "pending", afterAt: null }),
      source("warehouse", [], {
        status: "unavailable",
        afterAt: null,
        errorCode: "E-DATA-TIMEOUT",
      }),
      source("billing", [], { status: "unavailable", beforeAt: null, errorCode: "E-DATA-DENIED" }),
      source("legacy", [], { status: "unavailable", errorCode: "E-DATA-SOMETHING-NEW" }),
      source("untouched", []),
    ];

  return [
    source("app", [added("currencies", exact(3, { agent: 3 })), INVOICES, RENAMED, REMOVED]),
    source("cache", []),
  ];
};

/** The stand-in bridge's `data.schemaDiff`, through the same fixture api Data's previews use. */
export const schemaDiffAnswer = (scene: string, sessionId: SessionId, turn?: string) =>
  fixtureDataApi({
    schemaDiff: (turn): DataSchemaDiff => ({
      sessionId,
      ...(turn === "all" ? undefined : { turn: TurnId.make(turn) }),
      ...(scene === "session-data-pruned" || scene === "session-data-worst"
        ? { pruned: true }
        : undefined),
      sources: sourcesFor(scene),
    }),
  }).schemaDiff(
    { hostKey: "local", sessionId },
    turn === undefined ? undefined : TurnId.make(turn)
  );
