/** Work done on a read-only SQLite handle inside the query Worker; plain data in and out. */
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { Predicate } from "effect";
import { guardSqliteRead } from "./guard.ts";

export type SqliteValue = string | number | bigint | boolean | Uint8Array | null;

/** Text and blob cells longer than this many characters or bytes are clipped in the database. */
export const SQLITE_CELL_CAP = 10000;

export interface ReadJob {
  readonly kind: "read";
  readonly file: string;
  readonly sql: string;
  readonly params: ReadonlyArray<SqliteValue>;
  /** Rows to return; one more is read to establish truncation. */
  readonly limit: number;
}

export interface CatalogJob {
  readonly kind: "catalog";
  readonly file: string;
  /** One relation, or every table and view when absent. */
  readonly table?: string;
  /** Read indexes and foreign keys as well as columns. */
  readonly detail: boolean;
}

export type SqliteJob = ReadJob | CatalogJob;

export interface ReadOutput {
  readonly columns: ReadonlyArray<{ name: string; type: string }>;
  readonly rows: ReadonlyArray<ReadonlyArray<SqliteValue>>;
  /** Original sizes of clipped cells, keyed `row:column`. */
  readonly clipped: ReadonlyArray<readonly [string, number]>;
  readonly truncated: boolean;
}

export interface CatalogRelation {
  readonly name: string;
  readonly view: boolean;
  readonly sql: string | null;
  readonly columns: ReadonlyArray<{
    name: string;
    type: string;
    notnull: boolean;
    default: string | null;
    pk: number;
    hidden: number;
  }>;
  readonly foreignKeys: ReadonlyArray<{ from: string; table: string; to: string | null }>;
  readonly indexes: ReadonlyArray<{
    name: string;
    unique: boolean;
    origin: string;
    columns: string[];
    sql: string | null;
  }>;
}

export interface CatalogOutput {
  readonly relations: ReadonlyArray<CatalogRelation>;
  readonly total: number;
}

/** The database enforces read-only: no write can commit through this handle. */
export function openReadOnly(file: string) {
  // The Daemon resolved this path's links when it chose the file; one swapped in since is refused.
  if (realpathSync(file) !== file)
    throw Object.assign(new Error("The database file moved since Polaris found it."), {
      code: "SQLITE_CANTOPEN",
    });

  const db = new Database(file, { readonly: true, create: false, safeIntegers: true });
  db.exec("PRAGMA trusted_schema = OFF");
  db.exec("PRAGMA busy_timeout = 5000");

  return db;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function runRead(db: Database, job: ReadJob): ReadOutput {
  const checked = guardSqliteRead(job.sql);
  const statement = db.prepare(checked.sql);

  // sqlite3_stmt_readonly; older bun-types lack the property Bun 1.4.4 has.
  if ("readonly" in statement && statement.readonly === false)
    throw Object.assign(new Error("This statement writes to the database."), {
      code: "SQLITE_READONLY",
    });

  const names = statement.columnNames.slice(0, 256);
  const declared = statement.declaredTypes;
  const params = [...job.params];

  if (checked.keyword === "EXPLAIN") {
    const rows = statement.values(...params).slice(0, job.limit + 1);

    return finish(names, declared, rows, [], job.limit, statement.columnNames.length);
  }

  const { rows, clipped, over } = budgetedRows(db, checked.sql, params, job.limit);
  const output = finish(names, declared, rows, clipped, job.limit, statement.columnNames.length);

  return over ? { ...output, truncated: true } : output;
}

/** Bytes of cells one read returns at most, as the server engines' `READ_BYTES`. */
export const SQLITE_READ_BYTES = 1024 * 1024;

const cellBytes = (value: SqliteValue) => {
  if (Predicate.isString(value)) return value.length * 3 + 32;

  return value instanceof Uint8Array ? value.byteLength * 2 + 32 : 32;
};

/**
 * Rows read one at a time, each cell clipped in SQL (wider rows clip sooner), stopping once the
 * cells pass `SQLITE_READ_BYTES` so a wide or long result never fills the Daemon's memory.
 */
function budgetedRows(db: Database, sql: string, params: SqliteValue[], limit: number) {
  const inner = db.prepare(`SELECT * FROM (\n${sql}\n)`).columnNames.slice(0, 256);
  const cap = Math.min(SQLITE_CELL_CAP, Math.floor(131072 / Math.max(inner.length, 1)));

  const projection = inner.flatMap((name, i) => {
    const column = quote(name);
    const long = `typeof(${column}) IN ('text','blob') AND length(${column}) > ${cap}`;

    return [
      `CASE WHEN ${long} THEN substr(${column},1,${cap}) ELSE ${column} END AS v${i}`,
      `CASE WHEN ${long} THEN length(CAST(${column} AS BLOB)) END AS n${i}`,
    ];
  });

  const statement = db.prepare<Record<string, SqliteValue>, SqliteValue[]>(
    `SELECT ${projection.join(",") || "NULL"} FROM (\n${sql}\n) LIMIT ${limit + 1}`
  );

  const rows: SqliteValue[][] = [];
  const clipped: Array<readonly [string, number]> = [];
  let bytes = 0;

  for (const record of statement.iterate(...params)) {
    const row = inner.map((_, c) => record[`v${c}`] ?? null);
    bytes += row.reduce<number>((sum, value) => sum + cellBytes(value), 0);

    if (bytes > SQLITE_READ_BYTES && rows.length > 0) return { rows, clipped, over: true };

    inner.forEach((_, c) => {
      const size = record[`n${c}`];

      if (size !== null && size !== undefined) clipped.push([`${rows.length}:${c}`, Number(size)]);
    });
    rows.push(row);
  }

  return { rows, clipped, over: false };
}

function finish(
  names: ReadonlyArray<string>,
  declared: ReadonlyArray<string | null>,
  rows: ReadonlyArray<ReadonlyArray<SqliteValue>>,
  clipped: ReadonlyArray<readonly [string, number]>,
  limit: number,
  width: number
): ReadOutput {
  return {
    columns: names.map((name, i) => ({ name, type: (declared[i] ?? "").toLowerCase() })),
    rows: rows.slice(0, limit).map((row) => row.slice(0, 256)),
    clipped,
    truncated: rows.length > limit || width > 256,
  };
}

const text = (value: SqliteValue | undefined) =>
  value === null || value === undefined ? null : String(value);

export function runCatalog(db: Database, job: CatalogJob): CatalogOutput {
  const filter = "type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'";

  const total = Number(
    db.query(`SELECT count(*) FROM sqlite_schema WHERE ${filter}`).values()[0]![0]
  );

  const table = job.table === undefined ? undefined : relationName(db, job.table, filter);

  if (job.table !== undefined && table === undefined) return { relations: [], total };

  const objects = db
    .query(
      `SELECT name,type,sql FROM sqlite_schema WHERE ${filter}${table === undefined ? "" : " AND name=?"} ORDER BY name LIMIT 500`
    )
    .values(...(table === undefined ? [] : [table]));

  return {
    total,
    relations: objects.map(([name, type, sql]) =>
      relation(db, String(name), type === "view", text(sql), job.detail)
    ),
  };
}

/** One identifier: `"quoted"` (`""` is a quote) or bare; returns it and what follows. */
const identifier = (text: string): [string, string] | undefined => {
  if (!text.startsWith('"')) {
    const dot = text.indexOf(".");

    return dot === -1 ? [text, ""] : [text.slice(0, dot), text.slice(dot)];
  }

  const match = /^"((?:[^"]|"")*)"/.exec(text);

  return match ? [match[1]!.replaceAll('""', '"'), text.slice(match[0].length)] : undefined;
};

/** `name`, `"name"`, `main.name` or `"main"."name"` as the relation's name; undefined otherwise. */
const parsedName = (table: string) => {
  const first = identifier(table);

  if (first === undefined || first[0] === "") return undefined;

  if (first[1] === "") return first[0];

  if (!first[1].startsWith(".") || first[0].toLowerCase() !== "main") return undefined;
  const second = identifier(first[1].slice(1));

  return second === undefined || second[1] !== "" || second[0] === "" ? undefined : second[0];
};

/** An exact name first (SQLite allows dots and quotes inside names), then as an identifier. */
function relationName(db: Database, table: string, filter: string) {
  const find = (name: string) =>
    db.query(`SELECT name FROM sqlite_schema WHERE ${filter} AND name=?`).values(name)[0]?.[0];

  const exact = find(table);

  if (exact !== undefined) return String(exact);
  const name = parsedName(table);
  const parsed = name === undefined || name === table ? undefined : find(name);

  return parsed === undefined ? undefined : String(parsed);
}

function relation(
  db: Database,
  name: string,
  view: boolean,
  sql: string | null,
  detail: boolean
): CatalogRelation {
  const columns = db
    .query(`SELECT name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?) LIMIT 257`)
    .values(name)
    .map(([column, type, notnull, value, pk, hidden]) => ({
      name: String(column),
      type: String(type ?? ""),
      notnull: Number(notnull) === 1,
      default: text(value),
      pk: Number(pk),
      hidden: Number(hidden),
    }));

  if (!detail) return { name, view, sql, columns, foreignKeys: [], indexes: [] };

  const foreignKeys = db
    .query(`SELECT "from","table","to" FROM pragma_foreign_key_list(?) ORDER BY id,seq`)
    .values(name)
    .map(([from, target, to]) => ({ from: String(from), table: String(target), to: text(to) }));

  const indexes = db
    .query(`SELECT name,"unique",origin FROM pragma_index_list(?) ORDER BY name LIMIT 257`)
    .values(name)
    .map(([index, unique, origin]) => ({
      name: String(index),
      unique: Number(unique) === 1,
      origin: String(origin),
      columns: db
        .query(`SELECT name FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno`)
        .values(String(index))
        .map(([column]) => (column === null ? "<expression>" : String(column))),
      sql: text(
        db
          .query("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
          .values(String(index))[0]?.[0]
      ),
    }));

  return { name, view, sql, columns, foreignKeys, indexes };
}

export function runJob(job: SqliteJob): ReadOutput | CatalogOutput {
  const db = openReadOnly(job.file);

  try {
    return job.kind === "read" ? runRead(db, job) : runCatalog(db, job);
  } finally {
    db.close(false);
  }
}
