/**
 * The Table tab's scenes (U2): invoices filtered as in Paper D1, its Structure, no rows, a source
 * that needs approval, the bench's 10,000 × 20 events, and the worst case: 60 columns, a 200-char
 * text and a 1 MB JSON value cut short on the wire.
 */
import { TableDetail } from "@polaris/protocol";
import { type DataRow, DataValueTags } from "../../grid/value.ts";
import { openTable } from "../../model/store.ts";
import { tableTabId } from "../../model/tabs.ts";
import { setTableView } from "../../ui/table/state.ts";
import { fixtureDataApi, type FixtureTables } from "../fixtureApi.ts";
import type { DataScene } from "./scene.ts";

const { Json, Numeric, Timestamp, Truncated } = DataValueTags.cases;

type Column = TableDetail["columns"][number];

const column = (name: string, type: string, extra: Partial<Column> = {}): Column => ({
  name,
  type,
  nullable: true,
  default: null,
  pk: false,
  fk: null,
  ...extra,
});

const detail = (name: string, columns: ReadonlyArray<Column>, rows: number) =>
  new TableDetail({
    schema: "public",
    name,
    columns: [...columns],
    indexes: [{ name: `${name}_pkey`, columns: ["id"], unique: true, definition: "btree (id)" }],
    constraints: [],
    rowEstimate: rows,
  });

/** Deterministic, so screenshots and bench runs see the same rows. */
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

const BASE = Date.parse("2026-10-01T00:00:00Z");

const time = (next: () => number) =>
  Timestamp.make({ iso: new Date(BASE + Math.floor(next() * 30 * 86_400_000)).toISOString() });

const KINDS = ["invoice.sent", "invoice.paid", "payment.failed", "customer.created", "refund"];

const REGIONS = ["us-east-1", "eu-west-1", "ap-south-1"];

const pick = <A>(values: ReadonlyArray<A>, next: () => number): A | null =>
  values[Math.floor(next() * values.length)] ?? null;

export const BENCH_ROWS = 10_000;

const EVENT_COLUMNS = [
  column("id", "int8", { pk: true, nullable: false }),
  column("event_id", "uuid"),
  column("kind", "text"),
  column("actor_id", "uuid", { fk: { schema: "public", table: "users", column: "id" } }),
  column("amount_cents", "int8"),
  column("currency", "char(3)"),
  column("ratio", "numeric(6,4)"),
  column("ok", "bool"),
  column("created_at", "timestamptz"),
  column("updated_at", "timestamptz"),
  column("payload", "jsonb"),
  column("source", "text"),
  column("region", "text"),
  column("attempts", "int4"),
  column("latency_ms", "float8"),
  column("tag", "text"),
  column("session_id", "uuid"),
  column("ip", "inet"),
  column("note", "text"),
  column("version", "int4"),
];

const eventRows = (): ReadonlyArray<DataRow> => {
  const next = seeded(7);

  return Array.from({ length: BENCH_ROWS }, (_, i) => [
    i + 1,
    uuid(next),
    pick(KINDS, next),
    uuid(next),
    Math.floor(next() * 500_000),
    pick(["USD", "EUR", "GBP"], next),
    Numeric.make({ value: next().toFixed(4) }),
    next() > 0.1,
    time(next),
    next() < 0.3 ? null : time(next),
    Json.make({ text: JSON.stringify({ retry: next() > 0.5, step: Math.floor(next() * 9) }) }),
    pick(["api", "webhook", "cron"], next),
    pick(REGIONS, next),
    Math.floor(next() * 5),
    Math.round(next() * 90_000) / 100,
    next() < 0.5 ? null : `tag-${Math.floor(next() * 40)}`,
    uuid(next),
    `10.0.${Math.floor(next() * 255)}.${Math.floor(next() * 255)}`,
    `Retried after ${Math.floor(next() * 60)}s by the scheduler`,
    1 + Math.floor(next() * 3),
  ]);
};

const LONG_TITLE =
  "Quarterly reconciliation of overdue invoices across every regional ledger, including the " +
  "currency corrections the backfill agent proposed and the ones it flagged as needing a human";

const WORST_COLUMNS = [
  column("id", "int8", { pk: true, nullable: false }),
  column("title", "text"),
  column("body", "jsonb"),
  ...Array.from({ length: 57 }, (_, i) =>
    column(`attribute_${String(i + 1).padStart(2, "0")}_with_a_long_name`, "varchar(255)")
  ),
];

const MEGABYTE = 1024 * 1024;

const documentRows = (): ReadonlyArray<DataRow> => {
  const items = Array.from({ length: 400 }, (_, i) => ({ line: i + 1, note: "x".repeat(120) }));
  const json = JSON.stringify({ items });

  return Array.from({ length: 40 }, (_, i) => [
    i + 1,
    `${LONG_TITLE.slice(0, 200)}`,
    i === 0
      ? Truncated.make({ preview: JSON.stringify({ items }).slice(0, 64 * 1024), bytes: MEGABYTE })
      : Json.make({ text: json.slice(0, 2_000 + i * 50).replace(/,[^,]*$/, "]}") }),
    ...Array.from({ length: 57 }, (_, c) => (c % 7 === 3 ? null : `value ${i + 1}.${c + 1}`)),
  ]);
};

let tables: FixtureTables | null = null;

/** Built on first use: the bench's 10,000 rows aren't made for other scenes. */
const sceneTables = (): FixtureTables => {
  tables ??= {
    events: { detail: detail("events", EVENT_COLUMNS, BENCH_ROWS), rows: eventRows() },
    documents: { detail: detail("documents", WORST_COLUMNS, 40), rows: documentRows() },
  };

  return tables;
};

const api = () => fixtureDataApi(sceneTables());

const show =
  (table: string, view: { filter?: string; view?: "data" | "structure" } = {}, source = "app") =>
  (at: Parameters<NonNullable<DataScene["play"]>>[0]) => {
    openTable(source, table, at);
    setTableView(at, tableTabId(source, table), view);
  };

export const TABLE_SCENES = {
  table: { api, play: show("invoices", { filter: "status = 'overdue'" }) },
  structure: { api, play: show("invoices", { view: "structure" }) },
  "no-rows": { api, play: show("invoices", { filter: "status = 'void'" }) },
  denied: { api, play: show("events", {}, "analytics") },
  bench: { api, play: show("events") },
  worst: { api, play: show("documents") },
} satisfies Record<string, DataScene>;
