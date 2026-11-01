import assert from "node:assert/strict";
import { engine, emit } from "./report.mjs";

const postgres = {
  tree: `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
    c.reltuples AS row_estimate, count(a.attnum)::int AS column_count
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f')
    GROUP BY n.nspname,c.oid ORDER BY c.relname`,
  columns: `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS default_value,
    EXISTS(SELECT 1 FROM pg_constraint p WHERE p.conrelid=a.attrelid AND p.contype='p' AND a.attnum=ANY(p.conkey)) AS primary_key
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='t_0'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
  constraints: `SELECT c.conname AS name,c.contype AS kind,pg_get_constraintdef(c.oid) AS definition,
    rn.nspname AS target_schema,rc.relname AS target_table,
    ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n) AS source_columns,
    ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n) AS target_columns
    FROM pg_constraint c LEFT JOIN pg_class rc ON rc.oid=c.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid=rc.relnamespace WHERE c.conrelid='t_0'::regclass ORDER BY c.conname`,
  indexes: `SELECT ci.relname AS name,i.indisunique AS is_unique,i.indisprimary AS is_primary,
    pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid
    WHERE i.indrelid='t_0'::regclass ORDER BY ci.relname`,
  functions: `SELECT n.nspname AS schema,p.proname AS name,p.prokind AS kind,
    pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_function_result(p.oid) AS result
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema() ORDER BY p.proname,p.oid`,
};

const mysql = {
  tree: `SELECT t.TABLE_SCHEMA AS schema_name,t.TABLE_NAME AS name,t.TABLE_TYPE AS kind,
    t.TABLE_ROWS AS row_estimate,count(c.COLUMN_NAME) AS column_count
    FROM information_schema.TABLES t LEFT JOIN information_schema.COLUMNS c
      ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME
    WHERE t.TABLE_SCHEMA=DATABASE() GROUP BY t.TABLE_SCHEMA,t.TABLE_NAME,t.TABLE_TYPE,t.TABLE_ROWS
    ORDER BY t.TABLE_NAME`,
  columns: `SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,
    COLUMN_DEFAULT AS default_value,COLUMN_KEY AS column_key,EXTRA AS extra
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='t_0' ORDER BY ORDINAL_POSITION`,
  constraints: `SELECT t.CONSTRAINT_NAME AS name,t.CONSTRAINT_TYPE AS kind,k.COLUMN_NAME AS source_column,
    k.REFERENCED_TABLE_SCHEMA AS target_schema,k.REFERENCED_TABLE_NAME AS target_table,
    k.REFERENCED_COLUMN_NAME AS target_column,k.ORDINAL_POSITION AS position,
    r.UPDATE_RULE AS update_rule,r.DELETE_RULE AS delete_rule,cc.CHECK_CLAUSE AS check_clause
    FROM information_schema.TABLE_CONSTRAINTS t LEFT JOIN information_schema.KEY_COLUMN_USAGE k
      ON k.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND k.TABLE_NAME=t.TABLE_NAME AND k.CONSTRAINT_NAME=t.CONSTRAINT_NAME
    LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND r.TABLE_NAME=t.TABLE_NAME AND r.CONSTRAINT_NAME=t.CONSTRAINT_NAME
    LEFT JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=t.CONSTRAINT_NAME
    WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='t_0' ORDER BY t.CONSTRAINT_NAME,k.ORDINAL_POSITION`,
  indexes: `SELECT INDEX_NAME AS name,NON_UNIQUE AS non_unique,SEQ_IN_INDEX AS position,
    COLUMN_NAME AS column_name,EXPRESSION AS expression,INDEX_TYPE AS type,SUB_PART AS prefix_length
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='t_0' ORDER BY INDEX_NAME,SEQ_IN_INDEX`,
  functions: `SELECT ROUTINE_SCHEMA AS schema_name,ROUTINE_NAME AS name,ROUTINE_TYPE AS kind,
    DTD_IDENTIFIER AS result FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY ROUTINE_NAME`,
  parameters: `SELECT SPECIFIC_NAME AS name,ORDINAL_POSITION AS position,PARAMETER_MODE AS mode,
    PARAMETER_NAME AS parameter_name,DTD_IDENTIFIER AS type FROM information_schema.PARAMETERS
    WHERE SPECIFIC_SCHEMA=DATABASE() ORDER BY SPECIFIC_NAME,ORDINAL_POSITION`,
};

export async function introspection(sql) {
  for (const [part, statement] of Object.entries(engine === "postgres" ? postgres : mysql)) {
    const times = [];
    let rows;
    for (let n = 0; n < 5; n++) {
      const start = performance.now();
      rows = await sql.unsafe(statement);
      times.push(performance.now() - start);
    }
    emit(`introspection-${part}`, { statements: [statement], timesMs: times, count: rows.length, sample: rows.slice(0, 5) });
    if (part === "tree") assert.equal(rows.filter(row => /^t_\d+$/.test(row.name)).length, 300);
    if (part === "columns") assert.equal(rows.length, 4);
    if (part === "functions") assert.ok(rows.some(row => row.name === "spike_add"));
    if (part === "constraints") assert.ok(rows.some(row => row.target_table === "probe"));
  }
}
