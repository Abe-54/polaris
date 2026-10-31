/** Resolve primary keys and transactional storage on the same reserved connection as the write. */
import type { TransactionSQL } from "bun";
import type { DataSource } from "@polaris/protocol";
import { Schema } from "effect";
import { identifier, writeError } from "./writeSql.ts";

const Strings = Schema.Array(Schema.Struct({ name: Schema.String }));

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
      ? await tx`SELECT a.attname::text AS name FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE i.indrelid=to_regclass(${sql}) AND i.indisprimary ORDER BY k.ord`
      : await tx`SELECT CAST(COLUMN_NAME AS CHAR) AS name FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA=${found.schema} AND TABLE_NAME=${found.name} AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION`;

  return {
    schema: found.schema,
    table: found.name,
    sql,
    primaryKey: Schema.decodeUnknownSync(Strings)(keys).map((key) => key.name),
  };
}

export type WriteTable = Awaited<ReturnType<typeof writeTable>>;
