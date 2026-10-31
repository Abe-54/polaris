/** Rollback previews and guarded commits share the Query pool's cancellation and timeout boundary. */
import type { TransactionSQL } from "bun";
import {
  DataError,
  dataJsonBytes,
  scrubCredentials,
  scrubDataValue,
  type DataValue,
} from "@polaris/protocol";
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
import { decodeResult, mysqlValue, type RawResult, type Column } from "./values.ts";
import { writePlan, sqlTokens, identifier, writeError, updatedColumns } from "./writeSql.ts";
import { writeTable, type WriteTable } from "./writeTable.ts";
import { editStatements, type EditInput } from "./writeEdits.ts";
import { checkEdits, readWritten, refuseFloatKeys } from "./writeEditCheck.ts";
import type { LexicalMode } from "./guard.ts";
import { writePreflight } from "./writePreflight.ts";
import {
  identityRows,
  identityHash,
  insertedRows,
  explicitInsertColumns,
  insertedPreview,
  rawIdentity,
} from "./writeRows.ts";

export interface WriteInput extends Omit<ReadInput, "limit" | "catalogText"> {
  dryRun: boolean;
  signal?: AbortSignal;
  expected?: number;
  expectedIdentity?: string | undefined;
  previewed?: boolean | undefined;
}

export interface WritePreview {
  affected: number;
  previewed?: boolean | undefined;
  identity?: string;
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
    bindValues(where.params, input.source.engine),
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

      return bindValues([mysqlValue(buffer, column, false)], "mysql")[0]!;
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

export function cappedPreview(
  before: { columns: ReadonlyArray<Column>; rows: DataValue[][]; raw?: RawResult | undefined },
  after: DataValue[][],
  input: WriteInput
) {
  const columns = before.columns
    .slice(0, 256)
    .map((c) => scrubCredentials(c.name, knownCredentials(input.connection)).slice(0, 256));

  const previewBefore: DataValue[][] = [];
  const previewAfter: DataValue[][] = [];
  let bytes = dataJsonBytes(columns);

  const scrub = (row: DataValue[]) =>
    row
      .slice(0, 256)
      .map((value, i) =>
        /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential/i.test(
          before.columns[i]?.name ?? ""
        )
          ? "[redacted]"
          : scrubDataValue(value, knownCredentials(input.connection))
      );

  for (let i = 0; i < Math.max(before.rows.length, after.length); i++) {
    const left = before.rows[i] ? scrub(before.rows[i]!) : undefined;
    const right = after[i] ? scrub(after[i]!) : undefined;
    bytes += dataJsonBytes(left ?? []) + dataJsonBytes(right ?? []);

    if (bytes > 16000) break;

    if (left) previewBefore.push(left);

    if (right) previewAfter.push(right);
  }

  return { columns, before: previewBefore, after: previewAfter };
}

function checkUpdatedKey(
  input: WriteInput,
  plan: ReturnType<typeof writePlan>,
  table: WriteTable | undefined,
  mode: LexicalMode
) {
  if (!table) return;

  if (
    plan.keyword === "UPDATE" &&
    updatedColumns(plan.sql, mode).some((column) =>
      table.primaryKey.some((key) =>
        input.source.engine === "mysql"
          ? key.toLowerCase() === column.toLowerCase()
          : key === column
      )
    )
  )
    throw writeError(
      "Changing primary keys cannot be previewed by the original key.",
      "Change primary keys through a migration or the app's own code, not execute."
    );
}

async function insertEvidence(
  tx: TransactionSQL,
  active: Active,
  input: WriteInput,
  table: WriteTable,
  plan: ReturnType<typeof writePlan>,
  mode: LexicalMode,
  identities: RawResult,
  affected: number
) {
  const raw = insertedRows(
    identities,
    await identityRows(tx, active, input, table, { sql: "", params: [] }, true),
    table
  );

  if (raw.length !== affected)
    throw writeError(
      "The inserted rows changed during the write. The transaction was rolled back."
    );

  const explicit = explicitInsertColumns(
    plan,
    mode,
    raw.columns.map((c) => c.name)
  );

  const indexes = raw.columns.flatMap((col, i) =>
    explicit.some((name) =>
      input.source.engine === "mysql"
        ? name.toLowerCase() === col.name.toLowerCase()
        : name === col.name
    )
      ? [i]
      : []
  );

  return { raw, identity: identityHash(raw, indexes) };
}

function checkDrift(input: WriteInput, affected: number, identity: string | undefined) {
  if (input.expected !== undefined && input.expected !== affected)
    throw writeError(
      `The write affected ${affected} rows; the dry run affected ${input.expected}. The transaction was rolled back.`,
      "Preview the changed data and request approval again."
    );

  if (input.expectedIdentity !== undefined && identity !== input.expectedIdentity)
    throw writeError(
      "The affected row identities changed after the preview. The transaction was rolled back.",
      "Preview the changed data and request approval again."
    );
}

function writePreview(
  input: WriteInput,
  affected: number,
  triggers: boolean,
  identity: string | undefined,
  table: WriteTable | undefined,
  before: Awaited<ReturnType<typeof beforeRows>>,
  after: { rows: DataValue[][]; truncated: boolean },
  insert: RawResult | undefined
) {
  const inserted = insert ? insertedPreview(insert, input) : undefined;

  const preview = inserted
    ? cappedPreview({ ...inserted, rows: [] }, inserted.rows, input)
    : cappedPreview(before, after.rows, input);

  const clipped =
    before.raw?.truncated || after.truncated
      ? " Some rows or columns were omitted by the result budget."
      : "";

  return {
    affected,
    previewed: !triggers,
    ...(identity === undefined ? undefined : { identity }),
    ...preview,
    note:
      (table?.primaryKey.length
        ? "Up to 20 rows, read by primary key; preview capped at 16,000 bytes. Sequence values used by the preview aren't reused."
        : "Rows aren't shown: no primary key or this statement has no row preview. Sequence values used by the preview aren't reused.") +
      clipped,
    ...(table ? { target: { schema: table.schema, table: table.table } } : undefined),
  };
}

async function readIdentities(
  tx: TransactionSQL,
  active: Active,
  input: WriteInput,
  table: WriteTable | undefined,
  plan: ReturnType<typeof writePlan>,
  mode: LexicalMode,
  triggers: boolean
) {
  if (!table || triggers) return undefined;

  return identityRows(
    tx,
    active,
    input,
    table,
    plan.keyword === "INSERT"
      ? { sql: "", params: [] }
      : whereParams(plan, mode, input.params ?? []),
    plan.keyword === "INSERT"
  );
}

function notPreviewedNote(ddl: boolean, triggers: boolean) {
  if (ddl) return "Not previewed: this statement changes the schema";

  if (triggers) return "Not previewed: this table has triggers";

  return undefined;
}

async function write(tx: TransactionSQL, active: Active, input: WriteInput): Promise<WritePreview> {
  const mode = await configure(tx, input.source.engine, input.timeoutMs ?? 30000);
  const plan = writePlan(input.sql, input.source, mode);
  const table = plan.target ? await writeTable(tx, input.source, plan.target) : undefined;

  checkUpdatedKey(input, plan, table, mode);

  const triggers = await writePreflight(tx, input.source, table, plan.sql, mode);

  const noPreview = notPreviewedNote(plan.ddl, triggers);

  if (noPreview && input.dryRun)
    return {
      affected: 0,
      columns: [],
      before: [],
      after: [],
      previewed: false,
      note: noPreview,
    };

  if (triggers && input.previewed !== false && input.expected !== undefined)
    throw writeError("This table now has triggers. Request approval to run without preview.");

  const before = table
    ? await beforeRows(tx, active, input, plan, table, mode)
    : { columns: [], rows: [], raw: undefined };

  if (table) checkPreviewKeys(before.raw, table.primaryKey);

  const identities = await readIdentities(tx, active, input, table, plan, mode, triggers);
  let identity = identities ? identityHash(identities) : undefined;

  if (active.stopped) throw writeError("The write was cancelled.");

  const statement = table
    ? plan.sql.slice(0, plan.targetStart) + table.sql + plan.sql.slice(plan.targetEnd)
    : plan.sql;

  const query = tx<
    Array<never> & { count: number }
  >`${tx.unsafe(statement, bindValues(input.params ?? [], input.source.engine))}`;

  active.query = query;
  const result = await query;

  const affected = Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))(
    result.count ?? 0
  );

  const insert =
    table && identities && plan.keyword === "INSERT"
      ? await insertEvidence(tx, active, input, table, plan, mode, identities, affected)
      : undefined;

  if (insert) identity = insert.identity;
  checkDrift(input, affected, identity);

  const after =
    table && plan.keyword === "UPDATE"
      ? await afterRows(tx, active, input, table, before)
      : { rows: [], truncated: false };

  return writePreview(input, affected, triggers, identity, table, before, after, insert?.raw);
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
    try: (signal) =>
      (running = executeWrite(
        pools,
        input,
        input.signal ? AbortSignal.any([signal, input.signal]) : signal
      )),
    catch: (error) => queryError(error, knownCredentials(input.connection)),
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        await running?.catch(() => {});
      })
    )
  );
}

const onRow = (error: DataError, key: ReadonlyArray<DataValue>) =>
  new DataError({ ...Schema.encodeSync(DataError)(error), row: [...key] });

async function editRow(
  tx: TransactionSQL,
  active: Active,
  input: WriteInput,
  table: WriteTable,
  mode: Awaited<ReturnType<typeof configure>>,
  statement: ReturnType<typeof editStatements>[number],
  matched: Set<string>
) {
  const plan = writePlan(statement.sql, input.source, mode);
  await writePreflight(tx, input.source, table, plan.sql, mode);

  const keys = await identityRows(
    tx,
    active,
    input,
    table,
    whereParams(plan, mode, statement.params)
  );

  if (keys.length !== 1 || matched.has(rawIdentity(keys[0]!)))
    throw writeError(
      "These edits contain a missing or repeated database row.",
      "Reload the table and stage each row once."
    );
  matched.add(rawIdentity(keys[0]!));

  const query = tx<
    Array<never> & { count: number }
  >`${tx.unsafe(statement.sql, bindValues(statement.params, input.source.engine))}`;

  active.query = query;
  const result = await query;

  if (result.count !== 1)
    throw writeError(
      `An edit affected ${result.count ?? 0} rows instead of one. All edits were rolled back.`,
      "Reload the table and stage the edits again."
    );
}

export async function executeEdits(
  pools: DataPools,
  input: Omit<WriteInput, "dryRun" | "sql"> & { edits: EditInput },
  signal: AbortSignal
) {
  return executeTransaction(pools, input, signal, "", async (tx, active) => {
    const mode = await configure(tx, input.source.engine, input.timeoutMs ?? 30000);
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
    refuseFloatKeys(table);
    const statements = editStatements(requested, input.source.engine);
    const write = { ...input, sql: "", dryRun: false };
    await checkEdits(tx, active, write, table, statements);
    const matched = new Set<string>();

    for (const statement of statements) {
      if (active.stopped) throw writeError("The commit was cancelled.");

      try {
        await editRow(
          tx,
          active,
          { ...write, sql: statement.sql },
          table,
          mode,
          statement,
          matched
        );
      } catch (error) {
        throw onRow(queryError(error, knownCredentials(input.connection)), statement.key);
      }
    }

    return {
      affected: statements.length,
      written: await readWritten(tx, active, write, table, statements),
      target: { schema: table.schema, table: table.table },
    };
  });
}

export function editsEffect(pools: DataPools, input: Parameters<typeof executeEdits>[1]) {
  let running: ReturnType<typeof executeEdits> | undefined;

  return Effect.tryPromise({
    try: (signal) =>
      (running = executeEdits(
        pools,
        input,
        input.signal ? AbortSignal.any([signal, input.signal]) : signal
      )),
    catch: (error) => queryError(error, knownCredentials(input.connection)),
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        await running?.catch(() => {});
      })
    )
  );
}
