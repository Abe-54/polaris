/** Bounded relation sets, read once per catalog kind rather than once per table. */
import { columnsSql, indexesSql, constraintsSql } from "./catalog.ts";

const pgRelations = `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(c.oid,'SELECT') ORDER BY n.nspname,c.relname LIMIT 500`;

export const MYSQL_SNAPSHOT_TABLES = "__POLARIS_SNAPSHOT_TABLES__";

const mysqlSet = (sql: string, prefix: string) =>
  sql
    .replace("SELECT ", `SELECT ${prefix}TABLE_NAME AS relation_id,`)
    .replace(`${prefix}TABLE_NAME=?`, `${prefix}TABLE_NAME IN (${MYSQL_SNAPSHOT_TABLES})`);

const pgSet = (sql: string, relation: string) =>
  sql
    .replace("SELECT ", `SELECT ${relation}::text AS relation_id,`)
    .replace(`${relation}=to_regclass($1)`, `${relation} IN (${pgRelations})`);

const details = (sql: string, order = "name") =>
  `SELECT * FROM (SELECT d.*,ROW_NUMBER() OVER(PARTITION BY relation_id ORDER BY ${order}) AS detail_position FROM (${sql}) d) bounded WHERE detail_position<=257 ORDER BY relation_id,detail_position`;

const myIndexes = indexesSql.mysql.replace(
  "TABLE_NAME=?",
  `TABLE_NAME IN (${MYSQL_SNAPSHOT_TABLES})`
);

const myConstraints = `SELECT t.CONSTRAINT_NAME AS name,t.CONSTRAINT_TYPE AS kind,t.CONSTRAINT_TYPE AS definition
  FROM information_schema.TABLE_CONSTRAINTS t WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? ORDER BY t.CONSTRAINT_NAME`;

const myOrderedIndexes = `SELECT relation_id,name,is_unique,definition,columns FROM (SELECT d.*,
  JSON_ARRAYAGG(column_name) OVER(PARTITION BY relation_id,name ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS columns,
  ROW_NUMBER() OVER(PARTITION BY relation_id,name ORDER BY position) AS first_key FROM (${myIndexes}) d) ordered_indexes WHERE first_key=1`;

export const snapshotSql = {
  postgres: {
    tables: `SELECT c.oid::text AS relation_id,c.oid::text AS identity,n.nspname AS schema_name,c.relname AS name,
      CASE WHEN c.reltuples<0 OR c.relkind='v' THEN NULL ELSE c.reltuples::bigint END AS estimate,
      count(*) OVER() AS total FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid IN (${pgRelations}) ORDER BY n.nspname,c.relname`,
    columns: details(pgSet(columnsSql.postgres, "a.attrelid"), "position"),
    indexes: details(pgSet(indexesSql.postgres, "i.indrelid")),
    constraints: details(pgSet(constraintsSql.postgres, "conrelid")),
    objects: `SELECT c.oid::text AS relation_id,'view' AS kind,'view' AS name,pg_get_viewdef(c.oid,true) AS definition
      FROM pg_class c WHERE c.oid IN (${pgRelations}) AND c.relkind IN ('v','m')
      UNION ALL SELECT t.tgrelid::text,'trigger',t.tgname,pg_get_triggerdef(t.oid,true) FROM pg_trigger t WHERE t.tgrelid IN (${pgRelations}) AND NOT t.tgisinternal
      UNION ALL SELECT c.oid::text,'security','row_security',concat(c.relrowsecurity,':',c.relforcerowsecurity) FROM pg_class c WHERE c.oid IN (${pgRelations})`,
    total: `SELECT count(*) AS total FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(c.oid,'SELECT')`,
  },
  mysql: {
    tables: `SELECT TABLE_NAME AS relation_id,TABLE_SCHEMA AS schema_name,TABLE_NAME AS name,TABLE_ROWS AS estimate,(SELECT count(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()) AS total
      FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME LIMIT 501`,
    columns: details(mysqlSet(columnsSql.mysql, "c."), "position"),
    indexes: details(myOrderedIndexes),
    constraints: details(mysqlSet(myConstraints, "t.")),
    checks: `SELECT CONSTRAINT_NAME AS name,CHECK_CLAUSE AS definition FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME IN (${MYSQL_SNAPSHOT_TABLES})`,
    objects: `SELECT * FROM (SELECT TABLE_NAME AS relation_id,'view' AS kind,'view' AS name,VIEW_DEFINITION AS definition FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE()
      UNION ALL SELECT EVENT_OBJECT_TABLE,'trigger',TRIGGER_NAME,CONCAT(ACTION_TIMING,' ',EVENT_MANIPULATION,' ',ACTION_ORIENTATION,' ',ACTION_STATEMENT) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()) polaris_objects WHERE relation_id IN (${MYSQL_SNAPSHOT_TABLES})`,
    identities: `SELECT NAME AS name,CAST(TABLE_ID AS CHAR) AS identity FROM information_schema.INNODB_TABLES WHERE NAME IN (${MYSQL_SNAPSHOT_TABLES})`,
  },
};
