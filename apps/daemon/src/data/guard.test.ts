import { expect, test } from "bun:test";
import { guardSql } from "./guard.ts";
import { mysqlMatrix } from "./guard.matrix.ts";

for (const [sql, sqlMode, allowed] of mysqlMatrix) {
  test(`MySQL recorded guard: ${sql}`, () => {
    const run = () => guardSql(sql, { engine: "mysql", sqlMode });

    if (allowed) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ code: "E-DATA-READ-ONLY" }));
  });
}

for (const sql of [
  "SELECT 1; COMMIT; UPDATE probe SET v=1",
  "SELECT 1;;",
  "SELECT 'unclosed",
  "/* unclosed",
  "SELECT $tag$unclosed",
])
  test(`Postgres rejects ${sql}`, () => {
    expect(() => guardSql(sql, { engine: "postgres" })).toThrow();
  });

for (const sql of [
  "SELECT ';' AS value; /* tail */",
  "SELECT $$; COMMIT; UPDATE probe$$;",
  "SELECT $tag$;$tag$; -- tail",
  "SELECT E'escaped\\\'; still quoted';",
  "SELECT 1 /* outer /* nested ; */ done */;",
])
  test(`Postgres accepts quoted semicolon: ${sql}`, () => {
    expect(() => guardSql(sql, { engine: "postgres" })).not.toThrow();
  });

test("MySQL refuses ambiguous input when sql_mode cannot be read", () => {
  for (const sql of [String.raw`SELECT '\\'`, 'SELECT "x"'])
    expect(() => guardSql(sql, { engine: "mysql", sqlMode: null })).toThrow();
  expect(guardSql("SELECT 1", { engine: "mysql", sqlMode: null }).keyword).toBe("SELECT");
});

test("MySQL ANSI_QUOTES identifiers do not have backslash escapes", () => {
  expect(() =>
    guardSql(String.raw`SELECT 1 AS "x\"; DROP TABLE probe; -- "`, {
      engine: "mysql",
      sqlMode: "ANSI_QUOTES",
    })
  ).toThrow();
});

test("Postgres standard_conforming_strings changes quote termination", () => {
  const sql = String.raw`SELECT '\'; SELECT 2 -- '`;
  expect(() => guardSql(sql, { engine: "postgres", standardConformingStrings: true })).toThrow();
  expect(() =>
    guardSql(sql, { engine: "postgres", standardConformingStrings: false })
  ).not.toThrow();
});

test("only a terminator outside literals is removed for nesting", () => {
  expect(guardSql("SELECT ';'; -- tail", { engine: "postgres" }).sql).toBe("SELECT ';'");
});

for (const name of [
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "lo_export",
  "dblink_exec",
  "postgres_fdw_disconnect",
  "pg_notify",
  "pg_advisory_lock",
  "pg_try_advisory_lock",
  "set_config",
  "txid_current",
  "pg_current_xact_id",
  "pg_sleep_for",
  "query_to_xml",
  "pg_file_write",
])
  test(`refuses side-effect function ${name}, including quoted and commented calls`, () => {
    for (const sql of [`SELECT ${name}()`, `SELECT pg_catalog."${name}" /* gap */ ()`])
      for (const write of [false, true])
        expect(() => guardSql(sql, { engine: "postgres" }, write)).toThrow(
          expect.objectContaining({ code: "E-DATA-READ-ONLY" })
        );
    expect(() =>
      guardSql(`SELECT '${name}()' /* ${name}() */`, { engine: "postgres" })
    ).not.toThrow();
  });

for (const name of [
  "GET_LOCK",
  "RELEASE_LOCK",
  "RELEASE_ALL_LOCKS",
  "IS_FREE_LOCK",
  "IS_USED_LOCK",
  "BENCHMARK",
  "SLEEP",
])
  test(`MySQL refuses ${name} through reads and execute`, () => {
    for (const write of [false, true])
      expect(() =>
        guardSql(`SELECT \`${name}\` /* gap */ ()`, { engine: "mysql", sqlMode: "" }, write)
      ).toThrow();
    expect(() => guardSql(`SELECT '${name}()'`, { engine: "mysql", sqlMode: "" })).not.toThrow();
  });

test("backend identity and ordinary bounded sleeps remain available", () => {
  expect(() =>
    guardSql("SELECT pg_backend_pid(), pg_sleep(0.1)", { engine: "postgres" })
  ).not.toThrow();
});

test("shared-lock token sequences ignore comments but not literals", () => {
  for (const sql of ["SELECT 1 FOR/**/SHARE", "SELECT 1 LOCK -- comment\n IN SHARE MODE"])
    expect(() => guardSql(sql, { engine: "mysql", sqlMode: "" })).toThrow();
  expect(() => guardSql("SELECT 'FOR SHARE'", { engine: "mysql", sqlMode: "" })).not.toThrow();
});

test("MySQL user-variable assignment is refused before metadata probing", () => {
  for (const write of [false, true])
    expect(() =>
      guardSql("SELECT @x /* gap */ := 1", { engine: "mysql", sqlMode: "" }, write)
    ).toThrow();
  expect(() => guardSql("SELECT ':='", { engine: "mysql", sqlMode: "" })).not.toThrow();
});
