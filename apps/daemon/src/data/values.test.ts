import { expect, test } from "bun:test";
import { DataValueTags } from "@polaris/protocol";
import { Redacted, Predicate } from "effect";
import { decodeResult, type Column, type RawResult } from "./values.ts";

function result(columns: ReadonlyArray<Column>, values: Array<Uint8Array | null>): RawResult {
  return Object.assign([values], { columns });
}

test("Postgres text FETCH preserves decimal, bigint, JSON tokens and microseconds", () => {
  const columns = [
    { name: "n", type: 1700 },
    { name: "big", type: 20 },
    { name: "j", type: 3802 },
    { name: "ts", type: 1184 },
  ];

  const values = [
    "12345678901234567890.12345678901234567890",
    "9223372036854775807",
    '{"n": 9007199254740993}',
    "2026-10-30 07:04:56.123456+00",
  ].map((v) => Buffer.from(v));

  expect(decodeResult(result(columns, values), "postgres", []).rows[0]).toEqual([
    DataValueTags.cases.Numeric.make({ value: "12345678901234567890.12345678901234567890" }),
    DataValueTags.cases.BigInt.make({ value: "9223372036854775807" }),
    DataValueTags.cases.Json.make({ text: '{"n":9007199254740993}' }),
    DataValueTags.cases.Timestamp.make({ iso: "2026-10-30T07:04:56.123456+00:00" }),
  ]);
});

test("MySQL binary values preserve unsigned bigint and timezone-free DATETIME", () => {
  const columns = [
    { name: "big", type: 8, flags: 32 },
    { name: "ts", type: 7 },
    { name: "dt", type: 12 },
    { name: "tiny", type: 1 },
  ];

  const values = [
    Buffer.from("ffffffffffffffff", "hex"),
    Buffer.from("ea070a1e0c223840e20100", "hex"),
    Buffer.from("ea070a1e0c223840e20100", "hex"),
    Buffer.from([2]),
  ];

  expect(decodeResult(result(columns, values), "mysql", []).rows[0]).toEqual([
    DataValueTags.cases.BigInt.make({ value: "18446744073709551615" }),
    DataValueTags.cases.Timestamp.make({ iso: "2026-10-30T12:34:56.123456+00:00" }),
    "2026-10-30 12:34:56.123456",
    2,
  ]);
});

test("a huge cell is marked truncated and known credentials are removed from returned text", () => {
  const decoded = decodeResult(
    result([{ name: "x", type: 25 }], [Buffer.from("password-123" + "😀".repeat(100000))]),
    "postgres",
    [Redacted.make("password-123")]
  );

  expect(JSON.stringify(decoded.rows)).not.toContain("password-123");
  expect(Predicate.isTagged(decoded.rows[0]![0], "Truncated")).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(decoded.rows[0]![0]))).toBeLessThan(65536);
});
