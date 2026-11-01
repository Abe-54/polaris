/** Bind approval to every affected identity, independently of the capped display preview. */
import type { TransactionSQL } from "bun";
import type { DataValue } from "@polaris/protocol";
import { bindValues, cursorRead, mysqlRead, knownCredentials, type Active } from "./execution.ts";
import { decodeResult, type RawResult } from "./values.ts";
import { identifier, sqlTokens, writeError, type writePlan } from "./writeSql.ts";
import type { WriteInput } from "./writeExecution.ts";
import type { WriteTable } from "./writeTable.ts";
import type { LexicalMode } from "./guard.ts";

export const MAX_IDENTITIES = 10000;

export async function identityRows(
  tx: TransactionSQL,
  active: Active,
  input: WriteInput,
  table: WriteTable,
  where: { sql: string; params: ReadonlyArray<DataValue> },
  full = false
) {
  const columns =
    !full && table.primaryKey.length
      ? table.primaryKey.map((key) => identifier(key, input.source.engine)).join(",")
      : "*";

  const sql = `SELECT ${columns} FROM ${table.sql} ${where.sql} LIMIT ${MAX_IDENTITIES + 1} FOR UPDATE`;

  const raw =
    input.source.engine === "postgres"
      ? await cursorRead(
          tx,
          active,
          sql,
          bindValues(where.params, input.source.engine),
          MAX_IDENTITIES + 1
        )
      : await mysqlRead(
          tx,
          active,
          sql,
          bindValues(where.params, input.source.engine),
          MAX_IDENTITIES + 1
        );

  if (raw.truncated || raw.length > MAX_IDENTITIES)
    throw writeError(
      "The complete row identity exceeds the write preview limit.",
      "Narrow the write to at most 10,000 rows with complete keys or row images."
    );

  return raw;
}

export const rawIdentity = (
  row: ReadonlyArray<Uint8Array | null>,
  indexes?: ReadonlyArray<number>
) =>
  (indexes ?? row.map((_, i) => i))
    .map((i) => (row[i] === null ? "null" : `bytes:${Buffer.from(row[i]!).toString("base64")}`))
    .join("|");

export const identityHash = (raw: RawResult, indexes?: ReadonlyArray<number>) =>
  Bun.CryptoHasher.hash(
    "sha256",
    raw
      .map((row) => rawIdentity(row, indexes))
      .sort()
      .join("\n"),
    "hex"
  );

export function insertedRows(before: RawResult, after: RawResult, table: WriteTable) {
  const indexes = table.primaryKey.length
    ? table.primaryKey.map((key) => before.columns.findIndex((c) => c.name === key))
    : undefined;

  const counts = new Map<string, number>();

  for (const row of before) {
    const key = rawIdentity(row, indexes);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const rows = after.filter((row) => {
    const key = rawIdentity(row, indexes);
    const remaining = counts.get(key) ?? 0;

    if (remaining > 0) {
      counts.set(key, remaining - 1);

      return false;
    }

    return true;
  });

  return Object.assign(rows, { columns: after.columns });
}

export function explicitInsertColumns(
  plan: ReturnType<typeof writePlan>,
  mode: LexicalMode,
  columns: ReadonlyArray<string>
) {
  const tokens = sqlTokens(plan.sql.slice(plan.targetEnd), mode);

  if (tokens[0]?.word === "DEFAULT" && tokens[1]?.word === "VALUES") return [];

  if (tokens.some((token) => token.word === "DEFAULT"))
    throw writeError(
      "Explicit DEFAULT values cannot be bound to an insert preview.",
      "Omit database-filled columns from the INSERT column list."
    );

  if (tokens[0]?.word !== "(") return [...columns];
  const end = tokens.findIndex((token) => token.word === ")");
  const quote = mode.engine === "postgres" ? '"' : "`";

  return tokens
    .slice(1, end)
    .filter((t) => t.word !== ",")
    .map((t) =>
      t.raw.startsWith(quote)
        ? t.raw.slice(1, -1).replaceAll(quote + quote, quote)
        : mode.engine === "postgres"
          ? t.raw.toLowerCase()
          : t.raw
    );
}

export function insertedPreview(raw: RawResult, input: WriteInput) {
  return {
    ...decodeResult(
      Object.assign(raw.slice(0, 20), { columns: raw.columns }),
      input.source.engine,
      knownCredentials(input.connection)
    ),
    raw,
  };
}
