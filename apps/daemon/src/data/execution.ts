/** One prepared statement, a read-only transaction, a bounded read and an active-query deadline. */
import { type SQL, type ReservedSQL, type TransactionSQL } from "bun";
import { DataError, scrubCredentials, type DataSource, type DataValue } from "@polaris/protocol";
import { Effect, Match, Option, Predicate, Redacted, Schema } from "effect";
import type { DataConnection } from "./connection.ts";
import { guardSql } from "./guard.ts";
import { DataPools } from "./pools.ts";
import { decodeResult, type RawResult, typeName } from "./values.ts";

const DriverError = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  errno: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  sqlState: Schema.optionalKey(Schema.String),
});

const errorFields = Schema.decodeUnknownOption(DriverError);

const invalid = (message: string, fix: string) =>
  new DataError({ code: "E-DATA-SQL", message, fix });

export function queryError(
  cause: unknown,
  known: ReadonlyArray<Redacted.Redacted<string>>
): DataError {
  if (Predicate.isTagged(cause, "DataError")) return Schema.decodeUnknownSync(DataError)(cause);
  const parsed = errorFields(cause);
  const fields = Option.isSome(parsed) ? parsed.value : {};
  const state = String(fields.errno ?? fields.sqlState ?? "");
  const message = scrubCredentials(fields.message ?? "The database query failed.", known);

  if (["25006", "1792"].includes(state))
    return new DataError({
      code: "E-DATA-READ-ONLY",
      message,
      fix: "Use execute for writes when it is available; query only reads data.",
    });

  if (["57014", "3024", "1317"].includes(state))
    return new DataError({
      code: "E-DATA-TIMEOUT",
      message,
      fix: "Narrow the query and try again.",
    });

  if (
    /CONNECT|AUTH|PASSWORD|CLOSED|ECONN|ENOTFOUND|TIMEOUT/.test(fields.code ?? "") ||
    ["28P01", "28000", "1045"].includes(state)
  )
    return new DataError({
      code: "E-DATA-UNREACHABLE",
      message,
      fix: "The user can check this data source in Data (⌘4).",
    });

  return invalid(message, "Check the statement and parameter types.");
}

export function bindValues(params: ReadonlyArray<DataValue>) {
  return params.map((value) => {
    if (value === null || !Predicate.isObject(value)) return value;

    return Match.value(value).pipe(
      Match.tag("BigInt", "Numeric", (v) => v.value),
      Match.tag("Json", (v) => v.text),
      Match.tag("Timestamp", (v) => v.iso),
      Match.orElse(() => {
        throw invalid(
          "This parameter is a display-only value.",
          "Supply the original value instead of a bytes preview or truncated value."
        );
      })
    );
  });
}

export interface ReadInput {
  source: DataSource;
  connection: DataConnection;
  sql: string;
  params?: ReadonlyArray<DataValue>;
  limit: number;
  timeoutMs?: number;
  /** Only Daemon-authored catalog SQL can interpret binary-collated metadata as text. */
  catalogText?: boolean;
}

export const knownCredentials = (connection: DataConnection) => [
  connection.password,
  Redacted.make(encodeURIComponent(Redacted.value(connection.password))),
];

interface Active {
  query?: SQL.Query<unknown>;
  stopped: boolean;
  kill: Promise<unknown>;
}

function cancellation(
  active: Active,
  connection: ReservedSQL,
  control: SQL,
  engine: "postgres" | "mysql",
  id: number
) {
  if (active.stopped) return;
  active.stopped = true;

  if (engine === "postgres") {
    void active.query?.cancel();

    return;
  }

  // The target reservation is held until this KILL and the transaction rollback both settle.
  active.kill = control.unsafe(`KILL QUERY ${id}`).catch(async () => {
    await connection.close({ timeout: 0 });
  });
}

async function configure(tx: TransactionSQL, engine: "postgres" | "mysql", timeout: number) {
  if (engine === "postgres") {
    await tx`SELECT set_config('statement_timeout', ${String(timeout)}, true)`;
    await tx`SET LOCAL standard_conforming_strings = on`;
    await tx`SET LOCAL TIME ZONE 'UTC'`;

    return { engine, standardConformingStrings: true } as const;
  }

  await tx`SET SESSION max_execution_time = ${timeout}`;
  await tx`SET SESSION time_zone = '+00:00'`;
  let sqlMode: string | null = null;

  try {
    const rows = await tx<Array<{ mode: string }>>`SELECT @@session.sql_mode AS mode`;
    sqlMode = Schema.decodeUnknownSync(Schema.String)(rows[0]?.mode);
  } catch {
    /* Unknown mode is deliberately handled by the conservative lexer. */
  }

  return { engine, sqlMode } as const;
}

async function boundedRead(tx: TransactionSQL, input: ReadInput, active: Active) {
  const mode = await configure(tx, input.source.engine, input.timeoutMs ?? 30000);
  const checked = guardSql(input.sql, mode);

  if (active.stopped) throw invalid("The query was cancelled.", "Run it again when needed.");
  const params = bindValues(input.params ?? []);

  if (input.source.engine === "mysql") {
    if (["SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(checked.keyword))
      throw invalid(
        "Polaris can't bound this statement's output on MySQL yet.",
        "Use describe, or SELECT from information_schema."
      );
    const sql = `SELECT * FROM (\n${checked.sql}\n) AS polaris_capped LIMIT ${input.limit + 1}`;
    const query = tx<RawResult>`${tx.unsafe(sql, params)}`.raw();
    active.query = query;

    return await query;
  }

  const declare = tx`${tx.unsafe(`DECLARE polaris_data NO SCROLL CURSOR FOR\n${checked.sql}`, params)}`;
  active.query = declare;
  await declare;

  // Only this Daemon-authored FETCH uses text protocol; user SQL always uses the tagged path.
  const query = tx
    .unsafe<RawResult>(`FETCH FORWARD ${input.limit + 1} FROM polaris_data`)
    .simple()
    .raw();

  active.query = query;
  const result = await query;
  await tx`CLOSE polaris_data`;

  return result;
}

export async function executeRead(pools: DataPools, input: ReadInput, signal: AbortSignal) {
  const lease = await pools.acquire(input.source, input.connection);
  let reserved: ReservedSQL | undefined;
  const active: Active = { stopped: false, kill: Promise.resolve() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};

  let expired = false;

  try {
    reserved = await lease.sql.reserve({ signal });
    const connection = reserved;

    const ids =
      input.source.engine === "mysql"
        ? await connection<Array<{ id: number }>>`SELECT CONNECTION_ID() AS id`
        : [{ id: 0 }];

    const id = Schema.decodeUnknownSync(Schema.Int)(ids[0]?.id);
    abort = () => cancellation(active, connection, lease.control, input.source.engine, id);
    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) abort();
    timer = setTimeout(() => {
      expired = true;
      abort();
    }, input.timeoutMs ?? 30000);

    const raw = await connection.begin("read only", async (tx) => {
      try {
        return await boundedRead(tx, input, active);
      } finally {
        await active.kill;
      }
    });

    if (active.stopped)
      throw new DataError({
        code: expired ? "E-DATA-TIMEOUT" : "E-DATA-CANCELLED",
        message: expired ? "The query exceeded its time limit." : "The query was cancelled.",
        fix: "Narrow the query before trying again.",
      });

    const decoded = decodeResult(
      raw,
      input.source.engine,
      knownCredentials(input.connection),
      input.catalogText
    );

    const columns = decoded.columns.slice(0, 256).map((column) => ({
      name: scrubCredentials(column.name, knownCredentials(input.connection)).slice(0, 256),
      type: typeName(input.source.engine, column),
    }));

    return {
      columns,
      rows: decoded.rows.slice(0, input.limit).map((row) => row.slice(0, 256)),
      truncated: decoded.rows.length > input.limit || decoded.columns.length > 256,
    };
  } catch (error) {
    if (signal.aborted)
      throw new DataError({
        code: "E-DATA-CANCELLED",
        message: "The query was cancelled.",
        fix: "Run it again when needed.",
      });

    if (expired)
      throw new DataError({
        code: "E-DATA-TIMEOUT",
        message: "The query exceeded its time limit.",
        fix: "Narrow the query and try again.",
      });
    throw queryError(error, knownCredentials(input.connection));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await active.kill;
    reserved?.release();
    await lease.release();
  }
}

export function readEffect(pools: DataPools, input: ReadInput) {
  let running: ReturnType<typeof executeRead> | undefined;

  return Effect.tryPromise({
    try: (signal) => {
      running = executeRead(pools, input, signal);

      return running;
    },
    catch: (error) => queryError(error, knownCredentials(input.connection)),
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        await running?.catch(() => {});
      })
    )
  );
}
