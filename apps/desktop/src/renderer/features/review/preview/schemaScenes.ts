/**
 * Review's Data section on fixtures (Paper D4, ENG-645): `#review/session-data` (a Prisma
 * migration adds `currencies` and links `invoices`), `-worst` (240 tables, long names,
 * truncated, every baseline and state), `-pending`, `-unavailable` and `-unsupported`.
 */
import {
  type DataSchemaDiff,
  SCHEMA_DIFF_CAPABILITY,
  type SchemaSourceDiff,
  type SchemaTableDiff,
  type SessionId,
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

const column = (
  name: string,
  type: string,
  more: Partial<{ nullable: boolean; pk: boolean; default: string; fk: string }> = {}
) => ({
  name,
  type,
  nullable: more.nullable ?? false,
  default: more.default ?? null,
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

const sourcesFor = (scene: string): ReadonlyArray<SchemaSourceDiff> => {
  if (scene === "session-data-pending")
    return [source("app", [], { status: "pending", afterAt: null })];

  if (scene === "session-data-unavailable")
    return [source("app", [], { status: "unavailable", beforeAt: null })];

  if (scene === "session-data-worst")
    return [
      source(`${LONG}_replica`, manyTables(), { truncated: true, baseline: "previous-turn-end" }),
      source("staging", [{ ...INVOICES, rows: UNKNOWN }], { baseline: "first-use" }),
      source("analytics", [], { status: "pending", afterAt: null }),
      source("warehouse", [], { status: "unavailable", afterAt: null }),
      source("untouched", []),
    ];

  return [
    source("app", [added("currencies", exact(3, { agent: 3 })), INVOICES, RENAMED, REMOVED]),
    source("cache", []),
  ];
};

/** The stand-in bridge's `data.schemaDiff`, through the same fixture api Data's previews use. */
export const schemaDiffAnswer = (scene: string, sessionId: SessionId) =>
  fixtureDataApi({
    schemaDiff: (): DataSchemaDiff => ({ sessionId, sources: sourcesFor(scene) }),
  }).schemaDiff({ hostKey: "local", sessionId }, undefined);
