/** Grid commits refuse cells that changed since staging, or whose row is gone, before any write. */
import type { TransactionSQL } from "bun";
import { DataEditConflict, DataError, type DataValue } from "@polaris/protocol";
import { Predicate } from "effect";
import { bindValues, cursorRead, knownCredentials, mysqlRead, type Active } from "./execution.ts";
import { decodeResult } from "./values.ts";
import type { editStatements } from "./writeEdits.ts";
import { identifier, writeError } from "./writeSql.ts";
import type { WriteInput } from "./writeExecution.ts";
import type { WriteTable } from "./writeTable.ts";
import { serverEngine } from "./engine.ts";

const FLOAT_KEY = /^(?:real|float4|float8|double precision|float|double)\b/i;

/** Floating-point keys read back rounded, so `WHERE key = value` can miss the row. */
export function refuseFloatKeys(table: WriteTable) {
  if (table.keyTypes.some((type) => FLOAT_KEY.test(type.trim())))
    throw writeError(
      "This table's primary key includes a floating-point column, so its rows can't be matched exactly.",
      "Change these rows through the app's own code or a migration."
    );
}

/** One canonical text per value: tags and object keys sorted, so equal values compare equal. */
const canonical = (value: DataValue): string =>
  value === null || !Predicate.isObject(value)
    ? JSON.stringify(value)
    : JSON.stringify(
        Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      );

type EditStatement = ReturnType<typeof editStatements>[number];

/** The statement's changed columns in its row, locked, in the shapes a read returns. */
async function readCells(
  tx: TransactionSQL,
  active: Active,
  input: WriteInput,
  table: WriteTable,
  statement: EditStatement
) {
  const engine = serverEngine(input.source.engine);
  const columns = statement.before.map((cell) => identifier(cell.column, engine)).join(",");
  const sql = `SELECT ${columns} FROM ${table.sql} WHERE ${statement.where} FOR UPDATE`;
  const params = bindValues(statement.key, engine);

  const raw =
    engine === "postgres"
      ? await cursorRead(tx, active, sql, params, 2)
      : await mysqlRead(tx, active, sql, params, 2);

  return decodeResult(raw, engine, knownCredentials(input.connection)).rows[0];
}

/** Each edited cell as the database stored it, keyed and named as the Client sent it. */
export async function readWritten(
  tx: TransactionSQL,
  active: Active,
  input: WriteInput,
  table: WriteTable,
  statements: ReadonlyArray<EditStatement>
) {
  const written: Array<{ key: Array<DataValue>; column: string; value: DataValue }> = [];

  for (const statement of statements) {
    const current = await readCells(tx, active, input, table, statement);

    if (current === undefined) throw writeError("An edited row could not be read back.");
    statement.before.forEach((cell, i) =>
      written.push({ key: [...statement.key], column: cell.sent, value: current[i] ?? null })
    );
  }

  return written;
}

/**
 * Reads each row's changed columns under a row lock and compares them with what the user staged
 * from. Every conflict is collected so the grid can mark all of them at once.
 */
export async function checkEdits(
  tx: TransactionSQL,
  active: Active,
  input: WriteInput,
  table: WriteTable,
  statements: ReturnType<typeof editStatements>
) {
  const conflicts: Array<DataEditConflict> = [];

  for (const statement of statements) {
    if (active.stopped) throw writeError("The commit was cancelled.");

    if (statement.before.some((cell) => Predicate.isTagged(cell.value, "Truncated")))
      throw writeError(
        "A staged cell's original value was cut short, so it can't be checked.",
        "Reload the table and edit it again."
      );
    const current = await readCells(tx, active, input, table, statement);

    if (current === undefined) {
      conflicts.push(DataEditConflict.cases.Missing.make({ key: [...statement.key] }));
      continue;
    }

    statement.before.forEach((cell, i) => {
      const now = current[i] ?? null;

      if (canonical(now) !== canonical(cell.value))
        conflicts.push(
          DataEditConflict.cases.Changed.make({
            key: [...statement.key],
            column: cell.sent,
            value: now,
          })
        );
    });
  }

  if (conflicts.length > 0)
    throw new DataError({
      code: "E-DATA-CONFLICT",
      message: "Some staged cells changed or their rows no longer exist. Nothing was written.",
      fix: "Overwrite or drop each conflict, then commit again.",
      conflicts,
    });
}
