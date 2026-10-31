/**
 * Grid edits' scenes (E, ENG-645): staged cells on invoices, a failed commit, the remote bulk
 * confirm on a tan branch and a red production source, a table without a primary key, and a
 * remote source with writes off.
 */
import { DataSource, TableDetail } from "@polaris/protocol";
import { Schema } from "effect";
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
} satisfies Record<string, DataScene>;
