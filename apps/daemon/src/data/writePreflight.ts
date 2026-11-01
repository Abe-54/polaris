/** Inspect triggers under metadata locks before executing any preview statement. */
import type { TransactionSQL } from "bun";
import type { DataSource } from "@polaris/protocol";
import { Schema } from "effect";
import { guardFunctions } from "./functionGuard.ts";
import { sqlTokens, identifier, writeError, refuseCommaJoins } from "./writeSql.ts";
import type { LexicalMode } from "./guard.ts";
import type { WriteTable } from "./writeTable.ts";

const Triggers = Schema.Array(Schema.Struct({ body: Schema.String }));

const Names = Schema.Array(Schema.Struct({ name: Schema.String }));

const unquote = (s: string) => (s.startsWith("`") ? s.slice(1, -1).replaceAll("``", "`") : s);

function mysqlReferences(sql: string, source: DataSource, mode: LexicalMode) {
  refuseCommaJoins(sql, mode);
  const tokens = sqlTokens(sql, mode);
  const references: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (!["UPDATE", "INTO", "FROM", "JOIN"].includes(tokens[i]!.word)) continue;
    const raw = tokens[i + 1]?.raw;

    if (!raw || raw === "(") continue;
    const qualified = tokens[i + 2]?.word === ".";
    const schema = qualified ? unquote(raw) : source.database;

    if (schema !== source.database)
      throw writeError(
        "The statement names a different database.",
        "Select that database as a data source and request approval there."
      );
    references.push(qualified ? unquote(tokens[i + 3]?.raw ?? "") : unquote(raw));
  }

  return references;
}

async function mysqlPreflight(
  tx: TransactionSQL,
  sql: string,
  source: DataSource,
  mode: LexicalMode
) {
  const queue = mysqlReferences(sql, source, mode);
  const visited = new Set<string>();
  let hasTriggers = false;

  for (const table of queue) {
    if (visited.has(table)) continue;
    visited.add(table);

    if (visited.size > 100)
      throw writeError("The write's trigger dependencies exceed the inspection limit.");
    await tx.unsafe(
      `SELECT * FROM ${identifier(source.database, "mysql")}.${identifier(table, "mysql")} LIMIT 0`
    );

    const tables = Schema.decodeUnknownSync(Names)(
      await tx`SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=${source.database} AND TABLE_NAME=${table} AND ENGINE='InnoDB'`
    );

    if (!tables.length)
      throw writeError("Every table touched by a write or its triggers must use InnoDB.");

    const triggers = Schema.decodeUnknownSync(Triggers)(
      await tx`SELECT ACTION_STATEMENT AS body FROM information_schema.TRIGGERS
      WHERE EVENT_OBJECT_SCHEMA=${source.database} AND EVENT_OBJECT_TABLE=${table}`
    );

    hasTriggers ||= triggers.length > 0;

    for (const trigger of triggers) {
      await guardFunctions(tx, trigger.body, mode, true);
      queue.push(...mysqlReferences(trigger.body, source, mode));
    }
  }

  return hasTriggers;
}

async function guardExpressions(tx: TransactionSQL, table: WriteTable) {
  const functions = Schema.decodeUnknownSync(Names)(
    await tx`WITH RECURSIVE targets(oid) AS (
    SELECT to_regclass(${table.sql})::oid UNION SELECT i.inhrelid FROM pg_inherits i JOIN targets t ON i.inhparent=t.oid)
    SELECT p.proname::text AS name FROM pg_depend d JOIN pg_proc p ON p.oid=d.refobjid
      JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE d.refclassid='pg_proc'::regclass AND n.nspname <> 'pg_catalog' AND (
      (d.classid='pg_attrdef'::regclass AND d.objid IN (SELECT oid FROM pg_attrdef WHERE adrelid IN (SELECT oid FROM targets))) OR
      (d.classid='pg_constraint'::regclass AND d.objid IN (SELECT oid FROM pg_constraint WHERE conrelid IN (SELECT oid FROM targets))) OR
      (d.classid='pg_rewrite'::regclass AND d.objid IN (SELECT oid FROM pg_rewrite WHERE ev_class IN (SELECT oid FROM targets))) OR
      (d.classid='pg_policy'::regclass AND d.objid IN (SELECT oid FROM pg_policy WHERE polrelid IN (SELECT oid FROM targets))) OR
      (d.classid='pg_class'::regclass AND d.objid IN (SELECT indexrelid FROM pg_index WHERE indrelid IN (SELECT oid FROM targets))))`
  );

  if (functions.length)
    throw writeError(
      "The table's expressions call non-built-in functions.",
      "Use the app's own code for this write."
    );
}

export async function writePreflight(
  tx: TransactionSQL,
  source: DataSource,
  table: WriteTable | undefined,
  sql: string,
  mode: LexicalMode
) {
  await guardFunctions(tx, sql, mode, true);

  if (source.engine === "mysql") return mysqlPreflight(tx, sql, source, mode);

  if (!table) {
    const triggers = Schema.decodeUnknownSync(Names)(
      await tx`SELECT evtname::text AS name FROM pg_event_trigger WHERE evtenabled <> 'D'`
    );

    return triggers.length > 0;
  }

  await guardExpressions(tx, table);

  const triggers = Schema.decodeUnknownSync(Names)(
    await tx`WITH RECURSIVE targets(oid) AS (
    SELECT to_regclass(${table.sql})::oid UNION SELECT i.inhrelid FROM pg_inherits i JOIN targets t ON i.inhparent=t.oid)
    SELECT tgname::text AS name FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM targets) AND NOT tgisinternal`
  );

  return triggers.length > 0;
}
