/**
 * Grid edits' scenes (E, ENG-645): staged cells on invoices, a failed commit, the remote bulk
 * confirm on a tan branch and a red production source, a table without a primary key, a remote
 * source with writes off, and EF's conflicts, refusals and local writes off.
 */
import { DataEditConflict, DataSource, TableDetail } from "@polaris/protocol";
import { Schema } from "effect";
import type { IpcError } from "../../../../../shared/api.ts";
import type { DataValue } from "../../grid/value.ts";
import { openTable } from "../../model/store.ts";
import { tableTabId } from "../../model/tabs.ts";
import { stageEdit } from "../../ui/table/edits/store.ts";
import { fixtureDataApi, type FixtureData } from "../fixtureApi.ts";
import { FIXTURE_INVOICES, FIXTURE_SOURCES } from "../fixtures.ts";
import type { DataScene } from "./scene.ts";

const INVOICES = { schema: "public", name: "invoices" };

type At = Parameters<NonNullable<DataScene["play"]>>[0];

const COLUMNS = ["id", "number", "customer_id", "status", "total_cents", "currency"];

/** Stages `value` in row `row`'s `column` of the fixture invoices. */
const staged = (at: At, source: string, row: number, column: string, value: DataValue) => {
  const original = FIXTURE_INVOICES[row] ?? [];

  stageEdit(at, tableTabId(source, INVOICES), {
    key: [original[0] ?? null],
    column,
    before: original[COLUMNS.indexOf(column)] ?? null,
    value,
  });
};

const withEdits =
  (source: string, edits: ReadonlyArray<readonly [number, string, DataValue]>) => (at: At) => {
    openTable(source, INVOICES, at);

    for (const [row, column, value] of edits) staged(at, source, row, column, value);
  };

const sourcesWith = (name: string, change: Partial<Schema.Codec.Encoded<typeof DataSource>>) =>
  FIXTURE_SOURCES.map((s) =>
    s.name === name ? new DataSource({ ...Schema.encodeSync(DataSource)(s), ...change }) : s
  );

const api =
  (data: FixtureData = {}) =>
  () =>
    fixtureDataApi(data);

const AUDIT = new TableDetail({
  schema: "public",
  name: "audit_log",
  columns: [
    { name: "at", type: "timestamptz", nullable: false, default: "now()", pk: false, fk: null },
    { name: "actor", type: "text", nullable: false, default: null, pk: false, fk: null },
    { name: "action", type: "text", nullable: false, default: null, pk: false, fk: null },
  ],
  indexes: [],
  constraints: [],
  rowEstimate: 3,
});

const AUDIT_ROWS: ReadonlyArray<ReadonlyArray<DataValue>> = [
  ["2026-10-30T09:12:00.000Z", "billing-agent", "invoice.reminded"],
  ["2026-10-30T09:14:00.000Z", "you", "invoice.voided"],
  ["2026-10-30T09:20:00.000Z", "billing-agent", "invoice.paid"],
];

const BULK: ReadonlyArray<readonly [number, string, DataValue]> = [
  [1, "status", "paid"],
  [1, "currency", "EUR"],
  [4, "number", "INV-2004-B"],
];

const column = (name: string, type: string, pk = false) => ({
  name,
  type,
  nullable: !pk,
  default: null,
  pk,
  fk: null,
});

const SHIFTS = new TableDetail({
  schema: "public",
  name: "shifts",
  columns: [column("id", "int4", true), column("starts_at", "timestamp"), column("note", "text")],
  indexes: [],
  constraints: [],
  rowEstimate: 2,
  primaryKey: ["id"],
});

const READINGS = new TableDetail({
  schema: "public",
  name: "readings",
  columns: [column("at", "float8", true), column("value", "numeric(6,2)")],
  indexes: [],
  constraints: [],
  rowEstimate: 2,
  primaryKey: ["at"],
});

const rowKey = (row: number) => [FIXTURE_INVOICES[row]?.[0] ?? null];

/** Row 0's status changed since it was staged, and row 2 was deleted. */
const CONFLICT: IpcError = {
  code: "E-DATA-CONFLICT",
  message: "2 staged rows changed since they were read.",
  fix: "Read the rows again.",
  conflicts: [
    DataEditConflict.cases.Changed.make({ key: rowKey(0), column: "status", value: "void" }),
    DataEditConflict.cases.Missing.make({ key: rowKey(2) }),
  ],
};

export const EDIT_SCENES = {
  "edit-staged": {
    api: api(),
    play: withEdits("app", [
      [0, "status", "paid"],
      [2, "currency", null],
    ]),
  },
  "edit-error": {
    api: api({
      commitError: {
        code: "E-DATA-SQL",
        message: "value too long for type character varying(12)",
        fix: "Shorten the value, or change the column through a migration.",
      },
    }),
    play: withEdits("app", [[3, "number", "INV-2003-REISSUED-AFTER-AUDIT"]]),
  },
  "edit-confirm": { api: api(), play: withEdits("ledger", BULK) },
  "edit-confirm-production": {
    api: api({ sources: sourcesWith("analytics", { access: "approved", writes: "ask" }) }),
    play: withEdits("analytics", BULK),
  },
  "edit-no-key": {
    api: api({ tables: { audit_log: { detail: AUDIT, rows: AUDIT_ROWS } } }),
    play: (at: At) => openTable("app", { schema: "public", name: "audit_log" }, at),
  },
  "edit-writes-off": {
    api: api({ sources: sourcesWith("ledger", { writes: "off" }) }),
    play: (at: At) => openTable("ledger", INVOICES, at),
  },
  "edit-conflict": {
    api: api({ commitError: CONFLICT }),
    play: (at: At) => {
      withEdits("app", [
        [0, "status", "paid"],
        [1, "currency", "EUR"],
        [2, "currency", null],
        [2, "number", "INV-2002-B"],
      ])(at);
      stageEdit(at, tableTabId("app", INVOICES), {
        key: ["00000000-0000-4000-8000-000000000999"],
        column: "status",
        before: "draft",
        value: "void",
      });
    },
  },
  "edit-zone": {
    api: api({
      tables: {
        shifts: {
          detail: SHIFTS,
          rows: [
            ["1", "2026-10-30 09:00:00", "early"],
            ["2", "2026-10-30 17:00:00", "late"],
          ],
        },
      },
    }),
    play: (at: At) => openTable("app", { schema: "public", name: "shifts" }, at),
  },
  "edit-float-key": {
    api: api({
      tables: {
        readings: {
          detail: READINGS,
          rows: [
            ["0.1", "12.50"],
            ["0.2", "13.75"],
          ],
        },
      },
    }),
    play: (at: At) => openTable("app", { schema: "public", name: "readings" }, at),
  },
  "edit-writes-off-local": {
    api: api({ sources: sourcesWith("app", { writes: "off" }) }),
    play: (at: At) => openTable("app", INVOICES, at),
  },
} satisfies Record<string, DataScene>;
