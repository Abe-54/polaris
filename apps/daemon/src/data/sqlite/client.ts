/** Runs one SQLite job in a child process so a slow query never blocks the Daemon; maps its result. */
import {
  DataError,
  DataValueTags,
  DATA_CELL_BYTES,
  dataJsonBytes,
  scrubCredentials,
  scrubDataValue,
  type DataValue,
} from "@polaris/protocol";
import { Effect, Match, Predicate, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import { childEnv } from "../../service/childEnv.ts";
import { isEmbeddedPath } from "../../platform/detect.ts";
import type { CatalogJob, CatalogOutput, ReadJob, ReadOutput, SqliteValue } from "./jobs.ts";
import { ChildFailure } from "./protocol.ts";

const childCommand = (): ReadonlyArray<string> =>
  isEmbeddedPath(import.meta.path)
    ? [process.execPath, "data-sqlite"]
    : [process.execPath, fileURLToPath(new URL("../../main.ts", import.meta.url)), "data-sqlite"];

const isDataCode = Schema.is(DataError.fields.code);

const timedOut = () =>
  new DataError({
    code: "E-DATA-TIMEOUT",
    message: "The query exceeded its time limit.",
    fix: "Narrow the query and try again.",
  });

const cancelled = () =>
  new DataError({
    code: "E-DATA-CANCELLED",
    message: "The query was cancelled.",
    fix: "Run it again when needed.",
  });

/** SQLite error codes to Data errors; messages name the statement problem, never a secret. */
export function sqliteError(failure: ChildFailure): DataError {
  const code = failure.code ?? "";
  const known = isDataCode(code) ? code : undefined;

  if (failure.fix !== undefined && known !== undefined)
    return new DataError({ code: known, message: failure.message, fix: failure.fix });

  if (code.startsWith("SQLITE_READONLY") || code === "SQLITE_AUTH")
    return new DataError({
      code: "E-DATA-READ-ONLY",
      message: failure.message,
      fix: "SQLite data sources are read-only in Polaris; use query to read data.",
    });

  if (/^SQLITE_(CANTOPEN|NOTADB|PERM|IOERR|CORRUPT|BUSY|LOCKED)/.test(code))
    return new DataError({
      code: "E-DATA-UNREACHABLE",
      message: failure.message,
      fix: "The user can check this data source's file in Data (⌘4).",
    });

  return new DataError({
    code: "E-DATA-SQL",
    message: scrubCredentials(failure.message),
    fix: "Check the statement and parameter types.",
  });
}

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: ChildFailure }),
]);

const decodeReply = Schema.decodeUnknownSync(Reply);

const unavailable = () =>
  new DataError({
    code: "E-DATA-UNREACHABLE",
    message: "The SQLite reader is unavailable.",
    fix: "Check the Daemon installation and retry.",
  });

/**
 * Runs the job in `polaris data-sqlite` and resolves with its output. A process, not a Worker:
 * SQLite can't be interrupted from bun:sqlite, and only a kill stops a runaway statement.
 */
export async function runSqliteJob<A>(
  job: ReadJob | CatalogJob,
  signal: AbortSignal,
  timeoutMs = 30000
): Promise<A> {
  if (signal.aborted) throw cancelled();
  const deadline = AbortSignal.timeout(timeoutMs);

  const child = Bun.spawn([...childCommand()], {
    env: childEnv(),
    stdin: new Blob([serialize(job)]),
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.any([signal, deadline]),
  });

  const [stdout, code] = await Promise.all([new Response(child.stdout).bytes(), child.exited]);

  if (signal.aborted) throw cancelled();

  if (deadline.aborted) throw timedOut();

  if (code !== 0) throw unavailable();
  let reply: typeof Reply.Type;

  try {
    reply = decodeReply(deserialize(stdout));
  } catch {
    throw unavailable();
  }

  if (reply.ok)
    // SAFETY: the child replies with the output type of the job kind it was sent.
    return reply.value as A;

  throw sqliteError(reply.error);
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function sqliteValue(value: SqliteValue): DataValue {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return value;

  if (Predicate.isBigInt(value))
    return value <= MAX_SAFE && value >= -MAX_SAFE
      ? Number(value)
      : DataValueTags.cases.BigInt.make({ value: String(value) });

  if (Predicate.isNumber(value))
    return Number.isFinite(value)
      ? value
      : DataValueTags.cases.Numeric.make({ value: String(value) });
  const bytes = Buffer.from(value);

  return DataValueTags.cases.Bytes.make({ length: bytes.length, base64: bytes.toString("base64") });
}

function clippedValue(value: SqliteValue, size: number): DataValue {
  const preview = Predicate.isString(value)
    ? value
    : value instanceof Uint8Array
      ? `\\x${Buffer.from(value).toString("hex")}`
      : String(value);

  return DataValueTags.cases.Truncated.make({
    preview: preview.slice(0, Math.floor((DATA_CELL_BYTES - 128) / 6)),
    bytes: size,
  });
}

/** The same shape `executeRead` returns for server engines. */
export function decodeSqliteRead(output: ReadOutput) {
  const clipped = new Map(output.clipped);

  const cell = (value: SqliteValue, key: string): DataValue => {
    const size = clipped.get(key);

    const decoded = scrubDataValue(
      size === undefined ? sqliteValue(value) : clippedValue(value, size)
    );

    return dataJsonBytes(decoded) <= DATA_CELL_BYTES
      ? decoded
      : clippedValue(value, dataJsonBytes(decoded));
  };

  return {
    columns: output.columns.map((column) => ({
      name: scrubCredentials(column.name).slice(0, 256),
      type: column.type || "any",
    })),
    rows: output.rows.map((row, r) => row.map((value, c) => cell(value, `${r}:${c}`))),
    truncated: output.truncated,
  };
}

/** SQLite binds integers, reals, text and blobs; tagged values become their stored form. */
export function sqliteParams(params: ReadonlyArray<DataValue>): SqliteValue[] {
  return params.map((value): SqliteValue => {
    if (value === null || !Predicate.isObject(value))
      return Predicate.isBoolean(value) ? Number(value) : value;

    return Match.value(value).pipe(
      Match.tag("BigInt", (v) => BigInt(v.value)),
      Match.tag("Numeric", (v) => v.value),
      Match.tag("Json", (v) => v.text),
      Match.tag("Timestamp", (v) => v.iso),
      Match.tag("Bytes", (v) => {
        if (v.base64 === undefined)
          throw new DataError({
            code: "E-DATA-SQL",
            message: "This binary parameter has no bindable bytes.",
            fix: "Reload the original value before editing it.",
          });

        return new Uint8Array(Buffer.from(v.base64, "base64"));
      }),
      Match.orElse(() => {
        throw new DataError({
          code: "E-DATA-SQL",
          message: "This parameter is a display-only value.",
          fix: "Supply the original value instead of a bytes preview or truncated value.",
        });
      })
    );
  });
}

export const sqliteRead = (
  file: string,
  input: { sql: string; params?: ReadonlyArray<DataValue>; limit: number; timeoutMs?: number }
) =>
  Effect.tryPromise({
    try: async (signal) =>
      decodeSqliteRead(
        await runSqliteJob<ReadOutput>(
          {
            kind: "read",
            file,
            sql: input.sql,
            params: sqliteParams(input.params ?? []),
            limit: input.limit,
          },
          signal,
          input.timeoutMs
        )
      ),
    catch: (error) =>
      error instanceof DataError ? error : sqliteError({ message: "The SQLite query failed." }),
  });

export const sqliteCatalogRead = (file: string, table: string | undefined, detail: boolean) =>
  Effect.tryPromise({
    try: (signal) =>
      runSqliteJob<CatalogOutput>(
        { kind: "catalog", file, detail, ...(table === undefined ? undefined : { table }) },
        signal
      ),
    catch: (error) =>
      error instanceof DataError
        ? error
        : sqliteError({ message: "The SQLite catalog read failed." }),
  });
