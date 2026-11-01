import { connect, engine, emit, observe, query, single } from "./report.mjs";
import { combinedGuard, strictGuard } from "./lexical.mjs";

// This deliberately tests the Lead's proposed lexical rule, not a production SQL parser.
export function guard(statement) {
  const tokens = statement
    .replace(/'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`(?:``|[^`])*`/gs, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--(?=\s|$)[^\n]*|#[^\n]*/g, " ")
    .replace(/^\s*\(+\s*/, " ")
    .toUpperCase();
  const first = tokens.match(/^\s*([A-Z]+)/)?.[1];
  if (!new Set(["SELECT", "WITH", "TABLE", "VALUES", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"]).has(first)) return false;
  return !/\bINTO\s+(OUTFILE|DUMPFILE)\b|\bLOAD_FILE\b/.test(tokens);
}

export async function mysqlGuard(sql) {
  if (engine !== "mysql") return;
  await sql.unsafe("DROP TABLE IF EXISTS guard_target");
  await sql.unsafe("CREATE TABLE guard_target (id INT)");
  await sql.unsafe("DROP FUNCTION IF EXISTS spike_write");
  await sql.unsafe("CREATE FUNCTION spike_write() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE probe SET v=99 WHERE id=1; RETURN 1; END");
  await observe("guard-ddl-function-definition", ["CREATE FUNCTION spike_ddl() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN CREATE TABLE func_created (id INT); RETURN 1; END"], () => sql.unsafe("CREATE FUNCTION spike_ddl() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN CREATE TABLE func_created (id INT); RETURN 1; END"));
  const statements = [
    "SELECT * FROM probe", "/* ordinary */ ((SELECT * FROM probe))", "WITH c AS (SELECT 1) SELECT * FROM c",
    "TABLE probe", "VALUES ROW(1)", "SHOW TABLES", "DESCRIBE probe", "DESC probe", "EXPLAIN SELECT * FROM probe",
    "CREATE TABLE guard_created (id INT)", "DROP TABLE guard_target", "CALL spike_proc()", "SET @guard=1", "DO SLEEP(0.1)",
    "HANDLER probe OPEN", "LOCK TABLES probe WRITE", "XA START 'spike'", "PREPARE s FROM 'DROP TABLE guard_target'", "EXECUTE s",
    "/*!50000 DROP TABLE guard_target */",
    "SELECT * FROM probe FOR UPDATE", "SELECT * FROM probe LOCK IN SHARE MODE", "SELECT spike_write()",
    "SELECT spike_ddl()", "WITH c AS (SELECT 1) UPDATE probe SET v=99",
    "SELECT * INTO OUTFILE '/var/lib/mysql-files/blocked.csv' FROM probe",
    "SELECT * INTO DUMPFILE '/var/lib/mysql-files/blocked.dump' FROM probe",
    "SELECT LOAD_FILE('/etc/passwd')", "SELECT 'INTO OUTFILE LOAD_FILE' AS harmless",
    "SELECT * FROM probe /*!50000 INTO OUTFILE '/var/lib/mysql-files/spike-versioned.csv' */",
    "SELECT /*!50000 LOAD_FILE('/etc/hostname') */ AS contents",
    "SELECT * FROM probe INTO/**/OUTFILE '/var/lib/mysql-files/blocked-gap.csv'",
    "SELECT 1; DROP TABLE guard_target",
    "SELECT /*+ MAX_EXECUTION_TIME(10000) */ 1",
    "SELECT 'ordinary;string' AS value; /* trailing comment */",
    "SELECT 1 AS `semi;name`;", "SELECT 1 # ; DROP TABLE guard_target",
    "SELECT * FROM probe FOR SHARE",
  ];
  const [{ mode }] = await single(sql, "SELECT @@session.sql_mode AS mode");
  emit("mysql-guard-mode", { mode });
  for (const statement of statements) {
    const allowed = guard(statement);
    emit("mysql-guard-decision", { statement, allowed, strictAllowed: strictGuard(statement, engine), combinedAllowed: combinedGuard(statement, mode) });
    if (allowed)
      await observe("mysql-guard-server", ['sql.begin("read only")', "tagged unsafe fragment", statement], () => sql.begin("read only", async tx => [...await single(tx, statement)]));
    if (combinedGuard(statement, mode))
      await observe("mysql-combined-guard-server", ['sql.begin("read only")', "tagged unsafe fragment", statement], () => sql.begin("read only", async tx => [...await single(tx, statement)]));
  }
  await query(sql, "guard-write-postcondition", "SELECT * FROM probe");
  await query(sql, "guard-file-postcondition", "SELECT LOAD_FILE('/var/lib/mysql-files/spike-versioned.csv') AS contents");
  await sql.unsafe("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'");
  const modeStatement = String.raw`SELECT '\' INTO OUTFILE '/var/lib/mysql-files/spike-mode.csv' -- '`;
  const [{ mode: changedMode }] = await single(sql, "SELECT @@session.sql_mode AS mode");
  emit("mysql-guard-sql-mode", { statement: modeStatement, allowed: guard(modeStatement), strictAllowed: strictGuard(modeStatement, engine, true), combinedAllowed: combinedGuard(modeStatement, changedMode), sqlMode: changedMode });
  await observe("mysql-guard-mode-server", ['sql.begin("read only")', modeStatement], () => sql.begin("read only", tx => single(tx, modeStatement)));
  await sql.unsafe("SET SESSION sql_mode=DEFAULT");
  await query(sql, "guard-mode-file-postcondition", "SELECT LOAD_FILE('/var/lib/mysql-files/spike-mode.csv') AS contents");
}

if (import.meta.main) {
  const sql = connect();
  try { await mysqlGuard(sql); } finally { await sql.close(); }
}
