/**
 * RU2's stress tables (docs/reviews/2026-10-30-data-U2.md), for the grid's frame and memory
 * bench: 10,000 × 60 hostile values. `stress-long` puts a 59 KB text starting with a timestamp in
 * every 20th row; `stress-control` the same text without the timestamp.
 */
import { TableDetail } from "@polaris/protocol";
import { type DataRow, type DataValue, DataValueTags } from "../../grid/value.ts";
import { openTable } from "../../model/store.ts";
import { fixtureDataApi, type FixtureTables } from "../fixtureApi.ts";
import type { DataScene } from "./scene.ts";

const { Bytes, Json, Numeric, BigInt, Timestamp, Truncated } = DataValueTags.cases;

type Column = TableDetail["columns"][number];

const column = (name: string, type: string, pk = false): Column => ({
  name,
  type,
  nullable: !pk,
  default: null,
  pk,
  fk: null,
});

export const STRESS_ROWS = 10_000;

const FIXED = [
  column("id", "int8", true),
  column("event_id", "uuid"),
  column("rtl", "text"),
  column("multiline", "text"),
  column("nullish", "text"),
  column("exact", "numeric(30,0)"),
  column("lowest", "int8"),
  column("at", "timestamptz"),
  column("blob", "bytea"),
  column("doc", "json"),
  column("ok", "bool"),
  column("ratio", "float8"),
  column("cjk", "text"),
  column("formula", "text"),
];

const COLUMNS = [
  ...FIXED,
  ...Array.from({ length: 60 - FIXED.length }, (_, i) =>
    column(`extra_${String(i + 1).padStart(2, "0")}`, i % 2 === 0 ? "int4" : "varchar(64)")
  ),
];

const RTL = ["שלום עולם 123", "مرحبا بالعالم ٤٥٦", "חשבונית 2041 שולמה"];

const MULTILINE = ["first\nsecond", "col\tindented", "windows\r\nline"];

const NULLISH: ReadonlyArray<DataValue> = [null, "", "NULL"];

const CJK = ["請求書 🧾 支払い済み", "账单 💸 已付款", "청구서 ✅"];

const FORMULA = ['=HYPERLINK("http://x.test","click")', "+1+1", "-2+3", "@SUM(1,1)"];

const KILOBYTES_64 = 64 * 1024;

/** A 59 KB text; `stress-long` starts it with a timestamp, as a log line would. */
const LONG_TEXT = "log line with words ".repeat(3_000);

const rowOf = (i: number, long: string | null): DataRow => {
  const json =
    i % 500 === 0
      ? Truncated.make({
          preview: `{"items":[${'{"n":12345678901234567890},'.repeat(2_500)}`.slice(
            0,
            KILOBYTES_64
          ),
          bytes: 1_048_576,
        })
      : Json.make({ text: `{"amount":12345678901234567890,"n":${i},"p":0.1000000000000000055}` });

  return [
    i + 1,
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    RTL[i % 3] ?? null,
    long !== null && i % 20 === 0 ? long : (MULTILINE[i % 3] ?? null),
    NULLISH[i % 3] ?? null,
    Numeric.make({ value: `${"9".repeat(29)}${i % 10}` }),
    BigInt.make({ value: "-9223372036854775808" }),
    Timestamp.make({ iso: `2026-10-30T12:00:00.${String(i % 1_000_000).padStart(6, "0")}+05:30` }),
    Bytes.make({ length: 16, preview: "\\x00ff10ab" }),
    json,
    i % 2 === 0,
    i / 7,
    CJK[i % 3] ?? null,
    FORMULA[i % 4] ?? null,
    ...Array.from({ length: 60 - FIXED.length }, (_, c) =>
      (i + c) % 9 === 0 ? null : c % 2 === 0 ? i * c : `value ${i}.${c}`
    ),
  ];
};

const detail = (name: string) =>
  new TableDetail({
    schema: "public",
    name,
    columns: COLUMNS,
    indexes: [{ name: `${name}_pkey`, columns: ["id"], unique: true, definition: "btree (id)" }],
    constraints: [],
    rowEstimate: STRESS_ROWS,
  });

const table = (name: string, long: string | null) => ({
  detail: detail(name),
  rows: Array.from({ length: STRESS_ROWS }, (_, i) => rowOf(i, long)),
});

const LONG = {
  stress: null,
  stress_long: `2026-10-30T12:00 ${LONG_TEXT}`,
  stress_control: LONG_TEXT,
} as const;

type StressName = keyof typeof LONG;

const built = new Map<StressName, FixtureTables>();

/** Built on first use, one scene's table at a time. */
const tablesFor = (name: StressName): FixtureTables => {
  const existing = built.get(name);

  if (existing !== undefined) return existing;
  const tables = { [name]: table(name, LONG[name]) };

  built.set(name, tables);

  return tables;
};

const scene = (name: StressName): DataScene => ({
  api: () => fixtureDataApi({ tables: tablesFor(name) }),
  play: (at) => openTable("app", { schema: "public", name }, at),
});

export const STRESS_SCENES = {
  stress: scene("stress"),
  "stress-long": scene("stress_long"),
  "stress-control": scene("stress_control"),
} satisfies Record<string, DataScene>;
