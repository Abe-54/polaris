/** Opt-in tests use only operator-supplied disposable databases. */
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { DataSource, DataValueTags } from "@polaris/protocol";
import { Redacted } from "effect";
import { parseConnection } from "./connection.ts";
import { executeRead, executeTransaction } from "./execution.ts";
import { inspectPrivileges } from "./privileges.ts";
import { DataPools, sqlOptions } from "./pools.ts";

for (const engine of ["postgres", "mysql"] as const) {
  const url = process.env[engine === "postgres" ? "POLARIS_TEST_PG_URL" : "POLARIS_TEST_MYSQL_URL"];
  test.skipIf(!url)(
    `${engine}: functions, session reset, queued deadline, positions and server byte budget`,
    async () => {
      const { connection } = parseConnection({
        name: "xf",
        url: Redacted.make(url!),
        foundIn: { kind: "manual" },
      })!;

      const source = new DataSource({
        id: `xf-${engine}`,
        name: "xf",
        engine,
        host: connection.hostname,
        port: connection.port,
        database: connection.database,
        user: connection.username,
        locality: "local",
        foundIn: { kind: "manual" },
        access: "read",
        writes: "ask",
        label: { text: "", colour: "none" },
      });

      const pools = new DataPools();

      const admin = new SQL({
        ...sqlOptions(source, connection),
        allowPublicKeyRetrieval: engine === "mysql",
      });

      const run = (sql: string, timeoutMs = 30000, limit = 200) =>
        executeRead(
          pools,
          { source, connection, sql, timeoutMs, limit },
          new AbortController().signal
        );

      const name = `xf_${crypto.randomUUID().replaceAll("-", "")}`;

      try {
        const denied =
          engine === "postgres"
            ? [
                "SELECT dblink_exec('dbname=ledger','SELECT 1')",
                "SELECT pg_terminate_backend(0)",
                "SELECT pg_notify('xf','x')",
              ]
            : [
                "SELECT GET_LOCK('xf',0)",
                "SELECT BENCHMARK(1000,MD5('x'))",
                "SELECT SLEEP(10)",
                "SELECT @xf_value := 5 AS value",
              ];

        for (const sql of denied)
          await Promise.resolve(
            expect(run(sql)).rejects.toMatchObject({ code: "E-DATA-READ-ONLY" })
          );

        const privileges = await inspectPrivileges(
          pools,
          source,
          connection,
          new AbortController().signal
        );

        expect(privileges).toContain(engine === "postgres" ? "superuser" : "SUPER");

        if (engine === "postgres") {
          await admin.unsafe(
            `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 7'`
          );
          await Promise.resolve(
            expect(run(`SELECT public."${name}" /* lookup */ ()`)).rejects.toMatchObject({
              code: "E-DATA-READ-ONLY",
            })
          );
          await admin.unsafe(`DROP FUNCTION ${name}()`);
          await admin.unsafe(
            `CREATE FUNCTION ${name}() RETURNS text LANGUAGE sql AS $$ SELECT set_config('search_path','pg_catalog',false) $$`
          );
          expect((await run(`SELECT ${name}()`)).rows).toEqual([["pg_catalog"]]);

          for (let i = 0; i < 3; i++)
            expect((await run("SELECT current_setting('search_path') AS value")).rows).toEqual([
              ['"$user", public'],
            ]);
          expect((await run("SELECT pg_backend_pid() AS id")).rows[0]![0]).toBeGreaterThan(0);
        } else {
          await executeTransaction(
            pools,
            { source, connection },
            new AbortController().signal,
            "read only",
            async (tx) => {
              await tx`SELECT @xf_value := 5`;
            }
          );

          for (let i = 0; i < 3; i++)
            expect((await run("SELECT @xf_value AS value")).rows).toEqual([[null]]);
        }

        const lease = await pools.acquire(source, connection);
        const one = await lease.sql.reserve();
        const two = await lease.sql.reserve();
        const start = performance.now();

        try {
          await Promise.resolve(
            expect(run("SELECT 1", 75)).rejects.toMatchObject({ code: "E-DATA-TIMEOUT" })
          );
          expect(performance.now() - start).toBeLessThan(750);
        } finally {
          one.release();
          two.release();
          await lease.release();
        }

        expect((await run("SELECT 7 AS value")).rows).toEqual([[7]]);

        try {
          await run("SELECT 1\nFROMM x");
          throw new Error("expected SQL error");
        } catch (error) {
          expect(error).toMatchObject({ code: "E-DATA-SQL", sqlLine: 2 });

          if (engine === "postgres") expect(error).toMatchObject({ position: 16 });
          expect(String(error)).not.toContain("polaris_capped");
        }

        const huge = await run("SELECT repeat('x',17*1024*1024) AS huge");
        expect(huge.rows[0]![0]).toEqual(
          DataValueTags.cases.Truncated.make({ preview: "x".repeat(128), bytes: 17 * 1024 * 1024 })
        );
        expect(huge.truncated).toBe(true);

        const many =
          engine === "postgres"
            ? "SELECT repeat('x',1024) AS value FROM generate_series(1,10000)"
            : "WITH d AS (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) SELECT repeat('x',1024) AS value FROM d a,d b,d c,d e";

        const bounded = await run(many, 30000, 10000);
        expect(bounded.rows.length).toBeGreaterThan(200);
        expect(bounded.rows.length).toBeLessThan(1100);
        expect(bounded.truncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(2 * 1024 * 1024);
      } finally {
        if (engine === "postgres") await admin.unsafe(`DROP FUNCTION IF EXISTS ${name}()`);
        await pools.close();
        await admin.close({ timeout: 0 });
      }
    },
    60000
  );
}
