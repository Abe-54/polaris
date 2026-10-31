import { expect, test } from "bun:test";
import { DataSource, dataJsonBytes } from "@polaris/protocol";
import { Redacted } from "effect";
import { parseConnection } from "./connection.ts";
import { cappedPreview, writePreview, type WriteInput } from "./writeExecution.ts";

const source = new DataSource({
  id: "s",
  name: "app",
  engine: "postgres",
  host: "localhost",
  port: 5432,
  database: "app",
  locality: "local",
  foundIn: { kind: "manual" },
  access: "read",
  writes: "ask",
  label: { text: "", colour: "none" },
});

const connection = parseConnection({
  name: "app",
  url: Redacted.make("postgres://u:source-credential@localhost/app"),
  foundIn: { kind: "manual" },
})!.connection;

const input: WriteInput = {
  source,
  connection,
  sql: "UPDATE items SET password_hash=$1",
  params: ["new-private"],
  dryRun: true,
};

const table = {
  sql: '"public"."items"',
  schema: "public",
  table: "items",
  primaryKey: ["id"],
  keyTypes: ["integer"],
};

test("RRV F3: redacted credentials retain changed and unchanged facts without either value", () => {
  const preview = cappedPreview(
    {
      columns: [
        { name: "id", type: 23 },
        { name: "password_hash", type: 25 },
      ],
      rows: [
        [1, "old-private"],
        [2, "same-private"],
      ],
    },
    [
      [1, "new-private"],
      [2, "same-private"],
    ],
    input
  );

  expect(preview.redactedCells).toEqual([
    { row: 0, column: 1, changed: true },
    { row: 1, column: 1, changed: false },
  ]);
  expect(preview.before).toEqual([
    [1, "[redacted]"],
    [2, "[redacted]"],
  ]);
  expect(preview.after).toEqual([
    [1, "[redacted]"],
    [2, "[redacted]"],
  ]);
  expect(JSON.stringify(preview)).not.toContain("private");
});

test("RRV F8: preview facts distinguish row caps, clipping and key reads without prose or sequence claims", () => {
  const preview = writePreview(
    input,
    25,
    false,
    "identity",
    table,
    {
      columns: [
        { name: "id", type: 23 },
        { name: "v", type: 25 },
      ],
      rows: [
        [1, "a"],
        [2, "b"],
      ],
      raw: undefined,
    },
    {
      rows: [
        [1, "x".repeat(17000)],
        [2, "c"],
      ],
      truncated: true,
    },
    undefined,
    []
  );

  expect(preview.note).toBe("");
  expect(preview.previewFacts).toEqual({
    capped: true,
    truncated: true,
    readByKey: true,
    sequences: false,
  });
  expect(preview.after).toEqual([]);
});

test("RRV F3: redaction metadata shares the bounded display budget", () => {
  const columns = Array.from({ length: 100 }, (_, i) => ({ name: `secret_${i}`, type: 25 }));
  const rows = Array.from({ length: 20 }, () => columns.map(() => "sensitive"));
  const preview = cappedPreview({ columns, rows }, rows, input);
  expect(preview.truncated).toBe(true);
  expect(dataJsonBytes(preview)).toBeLessThan(16000);
  expect(preview.redactedCells.every(({ row }) => row < preview.before.length)).toBe(true);
});

test("RRV F9: INSERT after rows carry database-filled columns and sequence facts", () => {
  const raw = Object.assign([[Buffer.from("41"), Buffer.from("7")]], {
    columns: [
      { name: "id", type: 23 },
      { name: "v", type: 23 },
    ],
  });

  const preview = writePreview(
    { ...input, sql: "INSERT INTO items(v) VALUES(7)" },
    1,
    false,
    "identity",
    table,
    { columns: [], rows: [], raw: undefined },
    { rows: [], truncated: false },
    { raw, identity: "identity", databaseFilledColumns: ["id"], sequences: true },
    []
  );

  expect(preview.after).toEqual([[41, 7]]);
  expect(preview.databaseFilledColumns).toEqual(["id"]);
  expect(preview.previewFacts).toEqual({
    capped: false,
    truncated: false,
    readByKey: false,
    sequences: true,
  });
  expect(preview.note).toBe("");
});
