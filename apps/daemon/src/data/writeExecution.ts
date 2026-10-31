/** Rollback previews and guarded commits share the Query pool's cancellation and timeout boundary. */
import type { TransactionSQL } from "bun";
import { DataError, dataJsonBytes, scrubCredentials, type DataValue } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import {
  bindValues,
  configure,
  cursorRead,
  mysqlRead,
  executeTransaction,
  knownCredentials,
  queryError,
  type Active,
  type ReadInput,
} from "./execution.ts";
import type { DataPools } from "./pools.ts";
import { decodeResult, mysqlValue, type RawResult } from "./values.ts";
import { writePlan, sqlTokens, identifier, writeError, updatedColumns } from "./writeSql.ts";
import { writeTable, type WriteTable } from "./writeTable.ts";
import { editStatements, type EditInput } from "./writeEdits.ts";
import type { LexicalMode } from "./guard.ts";
import { guardFunctions } from "./functionGuard.ts";

export interface WriteInput extends Omit<ReadInput, "limit" | "catalogText"> {
  dryRun: boolean;
  expected?: number;
}

export interface WritePreview {
  affected: number;
  columns: string[];
  before: DataValue[][];
  after: DataValue[][];
  note: string;
  target?: { schema: string; table: string };
}

type PreviewRaw = RawResult & {
  truncated?: boolean;
  clipped?: ReadonlyMap<string, { preview: string; bytes: number }>;
};

class RolledBack extends Error {
  constructor(readonly result: WritePreview) {
    super("Data preview rolled back");
  }
}

async function rawRead(
  tx: TransactionSQL,
  active: Active,
  sql: string,
  params: Array<ReturnType<typeof bindValues>[number] | Uint8Array>,
  input: WriteInput
) {
  let raw: PreviewRaw;

  if (input.source.engine === "postgres") raw = await cursorRead(tx, active, sql, params, 20);
  else raw = await mysqlRead(tx, active, sql, params, 20);

  return { ...decodeResult(raw, input.source.engine, knownCredentials(input.connection)), raw };
}

export function whereParams(
  plan: ReturnType<typeof writePlan>,
  mode: LexicalMode,
  params: ReadonlyArray<DataValue>
) {
  if (mode.engine === "mysql") {
    const preceding = sqlTokens(plan.sql.slice(0, plan.whereOffset), mode).filter(
      (t) => t.word === "?"
    ).length;

    return { sql: plan.where, params: params.slice(preceding) };
  }

  const selected: DataValue[] = [];
  let sql = "";
  let end = 0;

  for (const token of sqlTokens(plan.where, mode)) {
    // PostgreSQL positional parameters are punctuation '$' followed by integer tokens.
    if (token.raw !== "$") continue;
    const match = plan.where.slice(token.start).match(/^\$(\d+)/);

    if (!match) continue;
    selected.push(params[Number(match[1]) - 1] ?? null);
    sql += plan.where.slice(end, token.start) + `$${selected.length}`;
    end = token.start + match[0].length;
  }

  return { sql: sql + plan.where.slice(end), params: selected };
}

async function beforeRows(
  tx: TransactionSQL,
  active: Active,
  input: WriteInput,
  plan: ReturnType<typeof writePlan>,
  table: WriteTable,
  mode: LexicalMode
) {
  if (!table.primaryKey.length || !["UPDATE", "DELETE"].includes(plan.keyword))
    return { columns: [], rows: [], raw: undefined };
  const where = whereParams(plan, mode, input.params ?? []);

  return rawRead(
    tx,
    active,
    `SELECT * FROM ${table.sql} ${where.sql} ORDER BY ${table.primaryKey.map((key) => identifier(key, input.source.engine)).join(",")} LIMIT 20 FOR UPDATE`,
    bindValues(where.params),
    input
  );
}

async function afterRows(
  tx: TransactionSQL,
  active: Active,
  input: WriteInput,
  table: WriteTable,
  before: Awaited<ReturnType<typeof beforeRows>>
) {
  const rows: DataValue[][] = [];
  let truncated = false;

  for (const row of before.raw ?? []) {
    const params = table.primaryKey.map((key) => {
      const index = before.columns.findIndex((col) => col.name === key);
      const value = row[index];

      if (value == null) throw writeError("A primary key could not be read.");
      const buffer = Buffer.from(value);

      if (input.source.engine === "postgres") return buffer.toString();
      const column = before.columns[index]!;

      if ([16, 245, 249, 250, 251, 252, 253, 254].includes(column.type)) return buffer;

      return bindValues([mysqlValue(buffer, column, false)])[0]!;
    });

    const predicate = table.primaryKey
      .map(
        (key, i) =>
          `${identifier(key, input.source.engine)}=${input.source.engine === "postgres" ? `$${i + 1}` : "?"}`
      )
      .join(" AND ");

    const result = await rawRead(
      tx,
      active,
      `SELECT * FROM ${table.sql} WHERE ${predicate} LIMIT 1`,
      params,
      input
    );

    if (result.rows.length !== 1)
      throw writeError(
        "An updated row could not be read by its original primary key.",
        "Change primary keys through a migration or the app's own code, not execute."
      );
    rows.push(...result.rows);
    truncated ||= result.raw.truncated === true;
  }

  return { rows, truncated };
}

export function checkPreviewKeys(raw: PreviewRaw | undefined, primaryKey: ReadonlyArray<string>) {
  if (!raw) return;

  for (const key of primaryKey) {
    const column = raw.columns.findIndex((value) => value.name === key);

    if (
      column < 0 ||
      raw.some((row, index) => row[column] == null || raw.clipped?.has(`${index}:${column}`))
    )
      throw writeError(
        "A primary key was omitted or clipped in the preview.",
        "Use your project's migration tool for this write."
      );
  }
}

function cappedPreview(
  before: Awaited<ReturnType<typeof beforeRows>>,
  after: DataValue[][],
  input: WriteInput
) {
  const columns = before.columns
    .slice(0, 256)
    .map((c) => scrubCredentials(c.name, knownCredentials(input.connection)).slice(0, 256));

  const previewBefore: DataValue[][] = [];
  const previewAfter: DataValue[][] = [];
  let bytes = dataJsonBytes(columns);

  for (let i = 0; i < before.rows.length; i++) {
    const left = before.rows[i]!.slice(0, 256);
    const right = after[i]?.slice(0, 256);
    bytes += dataJsonBytes(left) + dataJsonBytes(right ?? []);

    if (bytes > 16000) break;
    previewBefore.push(left);

    if (right) previewAfter.push(right);
  }

  return { columns, before: previewBefore, after: previewAfter };
}

async function write(tx: TransactionSQL, active: Active, input: WriteInput): Promise<WritePreview> {
  const mode = await configure(tx, input.source.engine, input.timeoutMs ?? 30000);
  const plan = writePlan(input.sql, input.source, mode);
  await guardFunctions(tx, plan.sql, mode);
  const table = plan.target ? await writeTable(tx, input.source, plan.target) : undefined;

  if (
    table &&
    plan.keyword === "UPDATE" &&
    updatedColumns(plan.sql, mode).some((column) => table.primaryKey.includes(column))
  )
    throw writeError(
      "Changing primary keys cannot be previewed by the original key.",
      "Change primary keys through a migration or the app's own code, not execute."
    );

  const before = table
    ? await beforeRows(tx, active, input, plan, table, mode)
    : { columns: [], rows: [], raw: undefined };

  if (table) checkPreviewKeys(before.raw, table.primaryKey);

  if (active.stopped) throw writeError("The write was cancelled.");

  const statement = table
    ? plan.sql.slice(0, plan.targetStart) + table.sql + plan.sql.slice(plan.targetEnd)
    : plan.sql;

  const query = tx<
    Array<never> & { count: number }
  >`${tx.unsafe(statement, bindValues(input.params ?? []))}`;

  active.query = query;
  const result = await query;

  const affected = Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))(
    result.count ?? 0
  );

  if (input.expected !== undefined && input.expected !== affected)
    throw writeError(
      `The write affected ${affected} rows; the dry run affected ${input.expected}. The transaction was rolled back.`,
      "Preview the changed data and request approval again."
    );

  const after =
    table && plan.keyword === "UPDATE"
      ? await afterRows(tx, active, input, table, before)
      : { rows: [], truncated: false };

  const preview = cappedPreview(before, after.rows, input);

  const clipped =
    before.raw?.truncated || after.truncated
      ? " Some rows or columns were omitted by the result budget."
      : "";

  return {
    affected,
    ...preview,
    note:
      (table?.primaryKey.length
        ? "Up to 20 rows, read by primary key; preview capped at 16,000 bytes. Sequence and external side effects may survive rollback."
        : "Rows aren't shown: no primary key or this statement has no row preview. Sequence and external side effects may survive rollback.") +
      clipped,
    ...(table ? { target: { schema: table.schema, table: table.table } } : undefined),
  };
}

export async function executeWrite(pools: DataPools, input: WriteInput, signal: AbortSignal) {
  let preview: WritePreview | undefined;

  try {
    return await executeTransaction(pools, input, signal, "", async (tx, active) => {
      const result = await write(tx, active, input);

      if (input.dryRun) {
        preview = result;
        throw new RolledBack(result);
      }

      return result;
    });
  } catch (error) {
    // executeTransaction maps driver errors after rollback; only our completed preview sets this slot.
    if (
      preview !== undefined &&
      !signal.aborted &&
      error instanceof DataError &&
      error.message === "Data preview rolled back"
    )
      return preview;
    throw error;
  }
}

export function writeEffect(pools: DataPools, input: WriteInput) {
  let running: ReturnType<typeof executeWrite> | undefined;

  return Effect.tryPromise({
    try: (signal) => (running = executeWrite(pools, input, signal)),
    catch: (error) => queryError(error, knownCredentials(input.connection)),
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        await running?.catch(() => {});
      })
    )
  );
}

export async function executeEdits(
  pools: DataPools,
  input: Omit<WriteInput, "dryRun" | "sql"> & { edits: EditInput },
  signal: AbortSignal
) {
  return executeTransaction(pools, input, signal, "", async (tx, active) => {
    await configure(tx, input.source.engine, input.timeoutMs ?? 30000);
    const requested = input.edits;

    const table = await writeTable(tx, input.source, {
      schema: requested.table.schema,
      table: requested.table.name,
    });

    if (
      !table.primaryKey.length ||
      JSON.stringify(table.primaryKey) !== JSON.stringify(requested.primaryKey)
    )
      throw writeError(
        "The table's primary key does not match these edits.",
        "Reload the table before editing it."
      );
    const statements = editStatements(requested, input.source.engine);

    for (const statement of statements) {
      if (active.stopped) throw writeError("The commit was cancelled.");

      const query = tx<
        Array<never> & { count: number }
      >`${tx.unsafe(statement.sql, bindValues(statement.params))}`;

      active.query = query;
      const result = await query;

      if (result.count !== 1)
        throw writeError(
          `An edit affected ${result.count ?? 0} rows instead of one. All edits were rolled back.`,
          "Reload the table and stage the edits again."
        );
    }

    return {
      affected: statements.length,
      target: { schema: table.schema, table: table.table },
    };
  });
}

export function editsEffect(pools: DataPools, input: Parameters<typeof executeEdits>[1]) {
  let running: ReturnType<typeof executeEdits> | undefined;

  return Effect.tryPromise({
    try: (signal) => (running = executeEdits(pools, input, signal)),
    catch: (error) => queryError(error, knownCredentials(input.connection)),
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        await running?.catch(() => {});
      })
    )
  );
}
