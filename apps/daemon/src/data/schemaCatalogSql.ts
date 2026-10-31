/** Bounded relation sets, read once per catalog kind rather than once per table. */
import { columnsSql, indexesSql, constraintsSql } from "./catalog.ts";

const pgRelations = `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(c.oid,'SELECT') ORDER BY n.nspname,c.relname LIMIT 500`;

const myRelations =
  "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME LIMIT 500";

const mysqlSet = (sql: string, prefix: string) =>
  sql
    .replace("SELECT ", `SELECT ${prefix}TABLE_NAME AS relation_id,`)
    .replace(
      `${prefix}TABLE_NAME=?`,
      `${prefix}TABLE_NAME IN (SELECT TABLE_NAME FROM (${myRelations}) polaris_relations)`
    );

const pgSet = (sql: string, relation: string) =>
  sql
    .replace("SELECT ", `SELECT ${relation}::text AS relation_id,`)
    .replace(`${relation}=to_regclass($1)`, `${relation} IN (${pgRelations})`);

const details = (sql: string, order = "name") =>
  `SELECT * FROM (SELECT d.*,ROW_NUMBER() OVER(PARTITION BY relation_id ORDER BY ${order}) AS detail_position FROM (${sql}) d) bounded WHERE detail_position<=257 ORDER BY relation_id,detail_position`;

const myIndexes = indexesSql.mysql.replace(
  "TABLE_NAME=?",
  `TABLE_NAME IN (SELECT TABLE_NAME FROM (${myRelations}) polaris_relations)`
);

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
    tables: `SELECT TABLE_NAME AS relation_id,TABLE_SCHEMA AS schema_name,TABLE_NAME AS name,TABLE_ROWS AS estimate,count(*) OVER() AS total
      FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME LIMIT 501`,
    columns: details(mysqlSet(columnsSql.mysql, "c."), "position"),
    indexes: details(myOrderedIndexes),
    constraints: details(mysqlSet(constraintsSql.mysql, "t.")),
    objects: `SELECT TABLE_NAME AS relation_id,'view' AS kind,'view' AS name,VIEW_DEFINITION AS definition FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE()
      UNION ALL SELECT EVENT_OBJECT_TABLE,'trigger',TRIGGER_NAME,CONCAT(ACTION_TIMING,' ',EVENT_MANIPULATION,' ',ACTION_ORIENTATION,' ',ACTION_STATEMENT) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()`,
    identities: `SELECT NAME AS name,CAST(TABLE_ID AS CHAR) AS identity FROM information_schema.INNODB_TABLES WHERE NAME LIKE CONCAT(DATABASE(),'/%')`,
  },
};
