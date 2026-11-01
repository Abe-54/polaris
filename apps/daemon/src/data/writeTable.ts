/** Resolve primary keys and transactional storage on the same reserved connection as the write. */
import type { TransactionSQL } from "bun";
import type { DataSource } from "@polaris/protocol";
import { Schema } from "effect";
import { identifier, writeError } from "./writeSql.ts";

const Keys = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }));

const Table = Schema.Array(
  Schema.Struct({ schema: Schema.String, name: Schema.String, engine: Schema.String })
);

async function resolveTable(
  tx: TransactionSQL,
  source: DataSource,
  target: { schema?: string; table: string }
) {
  let rows: unknown;

  if (source.engine === "postgres") {
    const qualified =
      target.schema === undefined
        ? identifier(target.table, source.engine)
        : `${identifier(target.schema, source.engine)}.${identifier(target.table, source.engine)}`;

    rows =
      await tx`SELECT n.nspname::text AS schema,c.relname::text AS name,c.relkind::text AS engine
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass(${qualified})`;
  } else {
    rows =
      await tx`SELECT CAST(TABLE_SCHEMA AS CHAR) AS \`schema\`,CAST(TABLE_NAME AS CHAR) AS name,COALESCE(ENGINE,'VIEW') AS engine
      FROM information_schema.TABLES WHERE TABLE_SCHEMA=${target.schema ?? source.database} AND TABLE_NAME=${target.table}`;
  }

  const found = Schema.decodeUnknownSync(Table)(rows)[0];

  if (!found) throw writeError("The write target no longer exists.");

  return found;
}

export async function writeTable(
  tx: TransactionSQL,
  source: DataSource,
  target: { schema?: string; table: string }
) {
  if (source.engine === "mysql" && target.schema !== undefined && target.schema !== source.database)
    throw writeError(
      "The statement names a different database.",
      "Select that database as a data source and request approval there."
    );
  const initial = await resolveTable(tx, source, target);
  const sql = `${identifier(initial.schema, source.engine)}.${identifier(initial.name, source.engine)}`;
  // Acquire metadata locks before verifying the engine and primary key used by the mutation.

  if (source.engine === "postgres") await tx.unsafe(`LOCK TABLE ${sql} IN ROW EXCLUSIVE MODE`);
  else await tx.unsafe(`SELECT * FROM ${sql} LIMIT 0`);
  const found = await resolveTable(tx, source, { schema: initial.schema, table: initial.name });

  if (source.engine === "mysql" && found.engine !== "InnoDB")
    throw writeError(
      "Only InnoDB tables can be written through Data.",
      "Use an InnoDB table; other MySQL engines can retain rows after rollback."
    );

  if (source.engine === "postgres" && !["r", "p"].includes(found.engine))
    throw writeError("Only ordinary and partitioned tables can be previewed.");

  const keys: unknown =
    source.engine === "postgres"
      ? await tx`SELECT a.attname::text AS name,format_type(a.atttypid,a.atttypmod)::text AS type FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE i.indrelid=to_regclass(${sql}) AND i.indisprimary ORDER BY k.ord`
      : await tx`SELECT CAST(k.COLUMN_NAME AS CHAR) AS name,CAST(c.DATA_TYPE AS CHAR) AS type FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=k.TABLE_SCHEMA AND c.TABLE_NAME=k.TABLE_NAME AND c.COLUMN_NAME=k.COLUMN_NAME
        WHERE k.TABLE_SCHEMA=${found.schema} AND k.TABLE_NAME=${found.name} AND k.CONSTRAINT_NAME='PRIMARY' ORDER BY k.ORDINAL_POSITION`;

  const decoded = Schema.decodeUnknownSync(Keys)(keys);

  return {
    schema: found.schema,
    table: found.name,
    sql,
    primaryKey: decoded.map((key) => key.name),
    keyTypes: decoded.map((key) => key.type),
  };
}

export type WriteTable = Awaited<ReturnType<typeof writeTable>>;
