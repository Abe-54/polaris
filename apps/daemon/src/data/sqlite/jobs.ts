/** Work done on a read-only SQLite handle inside the query Worker; plain data in and out. */
import { Database } from "bun:sqlite";
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

  const inner = db.prepare(`SELECT * FROM (\n${checked.sql}\n)`).columnNames.slice(0, 256);

  const projection = inner.flatMap((name) => {
    const column = quote(name);
    const long = `typeof(${column}) IN ('text','blob') AND length(${column}) > ${SQLITE_CELL_CAP}`;

    return [
      `CASE WHEN ${long} THEN substr(${column},1,${SQLITE_CELL_CAP}) ELSE ${column} END`,
      `CASE WHEN ${long} THEN length(CAST(${column} AS BLOB)) END`,
    ];
  });

  const rows = db
    .prepare(
      `SELECT ${projection.join(",") || "NULL"} FROM (\n${checked.sql}\n) LIMIT ${job.limit + 1}`
    )
    .values(...params);

  const clipped: Array<readonly [string, number]> = [];

  const values = rows.map((row, r) =>
    names.map((_, c) => {
      const size = row[c * 2 + 1];

      if (size !== null && size !== undefined) clipped.push([`${r}:${c}`, Number(size)]);

      return row[c * 2] ?? null;
    })
  );

  return finish(names, declared, values, clipped, job.limit, statement.columnNames.length);
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

/** An exact name first, then `main.`-qualified; SQLite allows dots inside names. */
function relationName(db: Database, table: string, filter: string) {
  const find = (name: string) =>
    db.query(`SELECT name FROM sqlite_schema WHERE ${filter} AND name=?`).values(name)[0]?.[0];

  const exact = find(table);

  if (exact !== undefined) return String(exact);

  if (!table.toLowerCase().startsWith("main.")) return undefined;
  const plain = find(table.slice(5));

  return plain === undefined ? undefined : String(plain);
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
