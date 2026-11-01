/** Metadata-only catalog queries; all identifiers from callers remain bound values. */
import {
  DataError,
  SchemaTree,
  TableDetail,
  TableSummary,
  type DataValue,
} from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";
import { readEffect, type ReadInput } from "./execution.ts";
import { DataPools } from "./pools.ts";
import { catalogValues, catalogError } from "./catalogValues.ts";
import { serverEngine } from "./engine.ts";
import { sqliteTable, sqliteTree } from "./sqlite/catalog.ts";

const noFile = () =>
  new DataError({
    code: "E-DATA-UNREACHABLE",
    message: "This SQLite source has no file.",
    fix: "The user can check this data source in Data (⌘4).",
  });

/** SQLite's tree, or one table's detail and sample SQL. */
const sqliteCatalog = (input: Omit<ReadInput, "sql" | "limit">, table: string | undefined) => {
  const file = input.connection.file;

  if (file === undefined) return Effect.fail(noFile());

  return table === undefined ? sqliteTree(file) : sqliteTable(file, table);
};

const pgVisible =
  "n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'";

const treeSql = {
  postgres: `SELECT n.nspname AS schema_name,c.relname AS name,c.relkind IN ('v','m') AS view,
    CASE WHEN c.reltuples<0 THEN NULL ELSE c.reltuples::bigint END AS estimate,
    (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS column_count,
    (SELECT coalesce(json_agg(x),'[]') FROM (SELECT a.attnum AS position,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 256) x) AS columns,
    count(*) OVER() AS total FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE ${pgVisible} AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(c.oid,'SELECT') ORDER BY n.nspname,c.relname`,
  mysql: `SELECT t.TABLE_SCHEMA AS schema_name,t.TABLE_NAME AS name,t.TABLE_TYPE='VIEW' AS view,
    t.TABLE_ROWS AS estimate,(SELECT count(*) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME) AS column_count,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('name',c.COLUMN_NAME,'type',c.COLUMN_TYPE)) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME AND c.ORDINAL_POSITION<=256) AS columns,
    count(*) OVER() AS total FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA=DATABASE() ORDER BY t.TABLE_NAME`,
};

const functionsSql = {
  postgres: `SELECT n.nspname AS schema_name,p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${pgVisible} ORDER BY n.nspname,p.proname`,
  mysql:
    "SELECT ROUTINE_SCHEMA AS schema_name,ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY ROUTINE_NAME",
};

export const columnsSql = {
  postgres: `SELECT a.attnum AS position,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable,
    CASE WHEN a.attgenerated='' THEN pg_get_expr(d.adbin,d.adrelid) ELSE NULL END AS default_value,
    CASE WHEN a.attgenerated<>'' THEN pg_get_expr(d.adbin,d.adrelid) ELSE '' END AS generated_expression,
    COALESCE((SELECT n.nspname || '.' || c.collname FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE c.oid=a.attcollation),'') AS collation_name,
    EXISTS(SELECT 1 FROM pg_constraint p WHERE p.conrelid=a.attrelid AND p.contype='p' AND a.attnum=ANY(p.conkey)) AS pk,
    (SELECT array_position(p.conkey,a.attnum) FROM pg_constraint p WHERE p.conrelid=a.attrelid AND p.contype='p') AS pk_position,
    (SELECT json_build_object('schema',rn.nspname,'table',rc.relname,'column',ra.attname) FROM pg_constraint f
      JOIN pg_class rc ON rc.oid=f.confrelid JOIN pg_namespace rn ON rn.oid=rc.relnamespace
      CROSS JOIN LATERAL unnest(f.conkey,f.confkey) k(src,dst) JOIN pg_attribute ra ON ra.attrelid=f.confrelid AND ra.attnum=k.dst
      WHERE f.conrelid=a.attrelid AND f.contype='f' AND k.src=a.attnum LIMIT 1) AS fk
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
  mysql: `SELECT c.ORDINAL_POSITION AS position,c.COLUMN_NAME AS name,c.COLUMN_TYPE AS type,c.IS_NULLABLE='YES' AS nullable,c.COLUMN_DEFAULT AS default_value,c.COLUMN_KEY='PRI' AS pk,
    c.GENERATION_EXPRESSION AS generated_expression,COALESCE(c.COLLATION_NAME,'') AS collation_name,c.EXTRA AS extra,
    (SELECT k.ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME
      AND k.COLUMN_NAME=c.COLUMN_NAME AND k.CONSTRAINT_NAME='PRIMARY') AS pk_position,
    (SELECT JSON_OBJECT('schema',k.REFERENCED_TABLE_SCHEMA,'table',k.REFERENCED_TABLE_NAME,'column',k.REFERENCED_COLUMN_NAME) FROM information_schema.KEY_COLUMN_USAGE k
      WHERE k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL LIMIT 1) AS fk
    FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION`,
};

export const indexesSql = {
  postgres: `SELECT ci.relname AS name,i.indisunique AS is_unique,pg_get_indexdef(i.indexrelid) AS definition,
    (SELECT coalesce(json_agg(pg_get_indexdef(i.indexrelid,k,true)),'[]') FROM generate_series(1,i.indnkeyatts) k) AS columns
    FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=to_regclass($1) ORDER BY ci.relname`,
  mysql: `SELECT TABLE_NAME AS relation_id,INDEX_NAME AS name,CAST(NON_UNIQUE=0 AS UNSIGNED) AS is_unique,INDEX_TYPE AS definition,
    SEQ_IN_INDEX AS position,CONCAT(COALESCE(COLUMN_NAME,EXPRESSION),IF(SUB_PART IS NULL,'',CONCAT('(',SUB_PART,')')),IF(COLLATION='D',' DESC','')) AS column_name
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`,
};

export const constraintsSql = {
  postgres: `SELECT conname AS name,contype AS kind,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1) ORDER BY conname`,
  mysql: `SELECT t.CONSTRAINT_NAME AS name,t.CONSTRAINT_TYPE AS kind,COALESCE(c.CHECK_CLAUSE,t.CONSTRAINT_TYPE) AS definition
    FROM information_schema.TABLE_CONSTRAINTS t LEFT JOIN information_schema.CHECK_CONSTRAINTS c
      ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
    WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? ORDER BY t.CONSTRAINT_NAME`,
};

const Columns = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }));

const Strings = Schema.Array(Schema.String);

const quote = (name: string, engine: "postgres" | "mysql") =>
  engine === "postgres" ? `"${name.replaceAll('"', '""')}"` : `\`${name.replaceAll("`", "``")}\``;

export const makeCatalogReader = (read: typeof readEffect) =>
  Effect.fnUntraced(
    function* (
      pools: DataPools,
      input: Omit<ReadInput, "sql" | "limit">,
      table?: string,
      snapshotTree?: SchemaTree
    ) {
      const engine = serverEngine(input.source.engine);
      const { plain, text, number, bool, json, decode } = catalogValues(engine);

      const rows = Effect.fnUntraced(function* (
        sql: string,
        params: ReadonlyArray<DataValue> = [],
        limit: number = 501
      ) {
        const result = yield* read(pools, { ...input, sql, params, limit, catalogText: true });

        return result.rows.map((row) =>
          Object.fromEntries<Schema.Json | undefined>(
            result.columns.map((column, i): [string, Schema.Json | undefined] => [
              column.name,
              plain(column.name, row[i]),
            ])
          )
        );
      });

      const tree = snapshotTree ? [] : yield* rows(treeSql[engine]);
      const functions = snapshotTree ? [] : yield* rows(functionsSql[engine]);

      const groups = new Map<
        string,
        { name: string; tables: TableSummary[]; views: TableSummary[]; functions: string[] }
      >();

      for (const row of tree.slice(0, 500)) {
        const name = text("tables.schema_name", row.schema_name);
        const group = groups.get(name) ?? { name, tables: [], views: [], functions: [] };

        const summary = decode("tables.summary", TableSummary, {
          name: text("tables.name", row.name),
          rowEstimate: row.estimate === null ? null : number("tables.estimate", row.estimate),
          columnCount: number("tables.column_count", row.column_count),
          columns: json("tables.columns", Columns, row.columns ?? []),
        });

        (bool("tables.view", row.view) ? group.views : group.tables).push(summary);
        groups.set(name, group);
      }

      for (const row of functions) {
        const name = text("functions.schema_name", row.schema_name);
        const group = groups.get(name) ?? { name, tables: [], views: [], functions: [] };
        group.functions.push(text("functions.name", row.name));
        groups.set(name, group);
      }

      if (table === undefined)
        return decode("schemas", SchemaTree, {
          loadedAt: new Date().toISOString(),
          schemas: [...groups.values()],
          truncatedTables: Math.max(0, number("tables.total", tree[0]?.total ?? 0) - 500),
        });
      // PostgreSQL resolves an unqualified name through its search_path; MySQL stays in DATABASE().
      const relation = engine === "mysql" && !snapshotTree ? table.split(".").at(-1)! : table;

      const identity =
        engine === "postgres"
          ? yield* rows(
              "SELECT n.nspname AS schema_name,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)",
              [relation],
              1
            )
          : [{ schema_name: input.source.database, name: relation }];

      if (identity.length === 0) return yield* missingTable();

      const schema = text("identity.schema_name", identity[0]?.schema_name);
      const name = text("identity.name", identity[0]?.name);
      const columns = yield* rows(columnsSql[engine], [relation], 256);

      if (columns.length === 0) return yield* missingTable();

      const indexes = normalizeIndexes(
        yield* rows(indexesSql[engine], [relation], 257 * 256),
        engine
      ).slice(0, 256);

      const constraints = yield* rows(constraintsSql[engine], [relation], 256);
      const match = tree.find((row) => row.schema_name === schema && row.name === name);

      const estimate = snapshotTree?.schemas
        .find((x) => x.name === schema)
        ?.tables.find((x) => x.name === name)?.rowEstimate;

      const primaryKey = columns
        .filter((row) => row.pk_position !== null && row.pk_position !== undefined)
        .map((row) => ({
          name: text("columns.name", row.name),
          at: number("columns.pk_position", row.pk_position),
        }))
        .sort((a, b) => a.at - b.at)
        .map((key) => key.name);

      const detail = decode("table.detail", TableDetail, {
        schema,
        name,
        primaryKey,
        columns: columns.map((row) => ({
          name: text("columns.name", row.name),
          type: text("columns.type", row.type),
          nullable: bool("columns.nullable", row.nullable),
          default:
            row.default_value === null ? null : text("columns.default_value", row.default_value),
          ...(row.generated_expression === undefined
            ? undefined
            : { generated: text("columns.generated", row.generated_expression) }),
          ...(row.collation_name === undefined
            ? undefined
            : { collation: text("columns.collation", row.collation_name) }),
          ...(row.extra === undefined ? undefined : { extra: text("columns.extra", row.extra) }),
          pk: bool("columns.pk", row.pk),
          fk: json(
            "columns.fk",
            Schema.NullOr(
              Schema.Struct({ schema: Schema.String, table: Schema.String, column: Schema.String })
            ),
            row.fk
          ),
        })),
        indexes: indexes.map((row) => ({
          name: text("indexes.name", row.name),
          columns: json("indexes.columns", Strings, row.columns),
          unique: bool("indexes.is_unique", row.is_unique),
          definition: text("indexes.definition", row.definition),
        })),
        constraints: constraints.map((row) => ({
          name: text("constraints.name", row.name),
          kind: text("constraints.kind", row.kind),
          definition: text("constraints.definition", row.definition),
        })),
        rowEstimate:
          estimate ??
          (match?.estimate === null || match === undefined
            ? null
            : number("tables.estimate", match.estimate)),
      });

      return { detail, sampleSql: `SELECT * FROM ${quote(schema, engine)}.${quote(name, engine)}` };
    },
    (effect, _pools, input, _table?: string, _snapshotTree?: SchemaTree) =>
      effect.pipe(
        Effect.catchDefect((cause) => {
          const error = Schema.decodeUnknownOption(DataError)(cause);

          return Effect.fail(
            Option.isSome(error) ? error.value : catalogError(input.source.engine, "result")
          );
        })
      )
  );

const serverCatalog = makeCatalogReader(readEffect);

export const readCatalog = (
  pools: DataPools,
  input: Omit<ReadInput, "sql" | "limit">,
  table?: string,
  snapshotTree?: SchemaTree
) =>
  input.source.engine === "sqlite"
    ? sqliteCatalog(input, table)
    : serverCatalog(pools, input, table, snapshotTree);

const missingTable = () =>
  new DataError({
    code: "E-DATA-SQL",
    message: "This table does not exist or is not visible to this database user.",
    fix: "List the data source schema and select a table from it.",
  });

export type CatalogRow = Record<string, Schema.Json | undefined>;

/** Build MySQL index keys in SEQ_IN_INDEX order; JSON_ARRAYAGG has no ordering guarantee. */
export function normalizeIndexes(rows: CatalogRow[], engine: "postgres" | "mysql"): CatalogRow[] {
  if (engine === "postgres") return rows;
  const groups = new Map<string, CatalogRow>();
  const { text, number } = catalogValues(engine);

  for (const row of rows.sort(
    (a, b) => number("index.position", a.position) - number("index.position", b.position)
  )) {
    const key = JSON.stringify([row.relation_id, row.name]);
    const group = groups.get(key);
    const column = text("index.column", row.column_name);

    if (group) {
      const columns = Schema.decodeUnknownSync(Schema.Array(Schema.String))(group.columns);
      group.columns = [...columns, column];
    } else groups.set(key, { ...row, columns: [column] });
  }

  return [...groups.values()];
}
