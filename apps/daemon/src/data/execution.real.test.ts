/** Opt-in disposable-database regressions. Never set these URLs to a database containing user data. */
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { DataSource } from "@polaris/protocol";
import { Effect, Redacted } from "effect";
import type { DataConnection } from "./connection.ts";
import { parseConnection } from "./connection.ts";
import { executeRead } from "./execution.ts";
import { DataPools, sqlOptions } from "./pools.ts";
import { mysqlMatrix } from "./guard.matrix.ts";
import { readCatalog } from "./catalog.ts";

for (const engine of ["postgres", "mysql"] as const) {
  const url = process.env[engine === "postgres" ? "POLARIS_TEST_PG_URL" : "POLARIS_TEST_MYSQL_URL"];
  test.skipIf(!url)(
    `${engine}: real read-only boundary, parameters, caps, timeout and release`,
    async () => {
      const parsed = parseConnection({
        name: "test",
        url: Redacted.make(url!),
        foundIn: { kind: "manual" },
      })!;

      expect(parsed.engine).toBe(engine);
      const { connection } = parsed;
      const prefix = `polaris_x_${crypto.randomUUID().replaceAll("-", "")}`;
      const table = `${prefix}_probe`;
      const million = `${prefix}_million`;
      const func = `${prefix}_write`;
      const view = `${prefix}_view`;

      const source = new DataSource({
        id: prefix,
        name: prefix,
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
        reachable: true,
      });

      // Fixture provisioning alone allows RSA retrieval on the operator-supplied disposable server.
      const admin = new SQL({
        ...sqlOptions(source, connection),
        allowPublicKeyRetrieval: engine === "mysql",
      });

      const pools = new DataPools();

      const run = (
        sql: string,
        params: ReadonlyArray<string | number> = [],
        limit = 200,
        timeoutMs = 30000,
        signal = new AbortController().signal
      ) => executeRead(pools, { source, connection, sql, params, limit, timeoutMs }, signal);

      try {
        await admin.unsafe(
          `CREATE TABLE ${table} (id INT PRIMARY KEY,v INT DEFAULT 7 CHECK (v>=0))`
        );
        await admin.unsafe(`INSERT INTO ${table} VALUES (1,0)`);
        await admin.unsafe(`CREATE VIEW ${view} AS SELECT id,v FROM ${table}`);

        const functionSql =
          engine === "postgres"
            ? `CREATE FUNCTION ${func}() RETURNS INT LANGUAGE plpgsql AS $$ BEGIN UPDATE ${table} SET v=99; RETURN 1; END $$`
            : `CREATE FUNCTION ${func}() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE ${table} SET v=99; RETURN 1; END`;

        await admin.unsafe(functionSql);

        await Promise.resolve(
          expect(run(`SELECT ${func}()`)).rejects.toMatchObject({ code: "E-DATA-READ-ONLY" })
        );

        for (const sql of [
          `SELECT 1; UPDATE ${table} SET v=71`,
          `SELECT 1; COMMIT; UPDATE ${table} SET v=72`,
        ])
          await Promise.resolve(
            expect(run(sql)).rejects.toMatchObject({ code: "E-DATA-READ-ONLY" })
          );
        const param = engine === "postgres" ? "$1" : "?";
        expect(
          (await run(`SELECT ${param} AS value`, ["'; COMMIT; DROP TABLE data_query_log; --"])).rows
        ).toEqual([["'; COMMIT; DROP TABLE data_query_log; --"]]);

        if (engine === "mysql") await checkMysql(run, admin, table, func, prefix);
        else await checkPostgres(run, admin, table, prefix);

        const post = await admin.unsafe<Array<{ v: number }>>(`SELECT v FROM ${table}`);
        expect(post).toHaveLength(1);
        expect(post[0]!.v).toBe(0);

        const rowsSql =
          engine === "postgres"
            ? "SELECT generate_series(1,1000000) AS id"
            : "WITH digits AS (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) SELECT 1 AS id FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e CROSS JOIN digits f";

        await admin.unsafe(`CREATE TABLE ${million} AS ${rowsSql}`);
        const capped = await run(`SELECT id FROM ${million}`);

        expect(capped.rows).toHaveLength(200);
        expect(capped.truncated).toBe(true);
        expect((await run(`SELECT id FROM ${million}`, [], 10000)).rows).toHaveLength(10000);

        const slow =
          engine === "postgres"
            ? "SELECT pg_sleep(2)"
            : `SELECT SUM(a.id + b.id + RAND()) AS n FROM ${million} a CROSS JOIN ${million} b`;

        await Promise.resolve(
          expect(run(slow, [], 200, 100)).rejects.toMatchObject({
            code: "E-DATA-TIMEOUT",
          })
        );
        const abort = new AbortController();
        const pending = run(slow, [], 200, 30000, abort.signal);
        const timer = setTimeout(() => abort.abort(), 100);

        try {
          await Promise.resolve(
            expect(pending).rejects.toMatchObject({ code: "E-DATA-CANCELLED" })
          );
        } finally {
          clearTimeout(timer);
        }

        expect((await run("SELECT 7 AS value")).rows).toEqual([[7]]);

        if (engine === "postgres") await checkEnvironment(source, connection);

        const schema = await Effect.runPromise(readCatalog(pools, { source, connection }, table));
        expect(
          await Effect.runPromise(
            Effect.flip(readCatalog(pools, { source, connection }, `${prefix}_missing`))
          )
        ).toMatchObject({ code: "E-DATA-SQL" });

        if (!("detail" in schema)) throw new Error("Expected a table detail");
        expect(schema.detail.columns.map((column) => column.name)).toEqual(["id", "v"]);
        expect(schema.detail.columns[0]!.pk).toBe(true);
        expect(schema.detail.columns[1]!.default).toBe("7");
        expect(
          schema.detail.indexes.some((index) => index.unique && index.columns.includes("id"))
        ).toBe(true);
        expect(
          schema.detail.constraints.some(
            (constraint) =>
              constraint.definition.includes("v") && constraint.definition.includes("0")
          )
        ).toBe(true);
        const tree = await Effect.runPromise(readCatalog(pools, { source, connection }));

        if (!("schemas" in tree)) throw new Error("Expected schema tree");
        expect(
          tree.schemas.flatMap((group) => group.views).some((item) => item.name === view)
        ).toBe(true);
        expect(
          tree.schemas.flatMap((group) => group.functions).some((item) => item.startsWith(func))
        ).toBe(true);
      } finally {
        await pools.close();
        await admin.unsafe(`DROP FUNCTION IF EXISTS ${func}${engine === "postgres" ? "()" : ""}`);
        await admin.unsafe(`DROP TABLE IF EXISTS ${million}`);
        await admin.unsafe(`DROP VIEW IF EXISTS ${view}`);
        await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
        await admin.close({ timeout: 0 });
      }
    },
    120000
  );
}

type Run = (
  sql: string,
  params?: ReadonlyArray<string | number>,
  limit?: number,
  timeoutMs?: number,
  signal?: AbortSignal
) => ReturnType<typeof executeRead>;

async function checkMysql(run: Run, admin: SQL, table: string, func: string, prefix: string) {
  for (const [statement, , allowed] of mysqlMatrix) {
    const sql = statement
      .replaceAll(/\bprobe\b/g, table)
      .replaceAll("spike_write", func)
      .replaceAll("guard_target", table)
      .replaceAll("guard_created", `${prefix}_forbidden`);

    if (!allowed)
      await Promise.resolve(expect(run(sql)).rejects.toMatchObject({ code: "E-DATA-READ-ONLY" }));
    else if (/^(SHOW|DESCRIBE|DESC|EXPLAIN)\b/.test(sql))
      await Promise.resolve(expect(run(sql)).rejects.toMatchObject({ code: "E-DATA-SQL" }));
    else if (/FOR UPDATE|spike_ddl|UPDATE|_write\(/.test(sql))
      await Promise.resolve(expect(run(sql)).rejects.toBeInstanceOf(Error));
    else await run(sql);
  }

  for (const lock of ["LOCK IN SHARE MODE", "FOR SHARE"]) {
    await Promise.resolve(
      expect(run(`SELECT * FROM ${table} ${lock}`)).rejects.toMatchObject({
        code: "E-DATA-READ-ONLY",
      })
    );
    await admin.unsafe(`UPDATE ${table} SET v=0 WHERE id=1`);
  }
}

async function checkEnvironment(source: DataSource, connection: DataConnection) {
  const oldHost = process.env.PGHOST;
  const oldDb = process.env.PGDATABASE;

  try {
    process.env.PGHOST = "invalid.invalid";
    process.env.PGDATABASE = "wrong_database";
    const isolated = new DataPools();

    try {
      expect(
        (
          await executeRead(
            isolated,
            { source, connection, sql: "SELECT current_database() AS name", limit: 1 },
            new AbortController().signal
          )
        ).rows
      ).toEqual([[connection.database]]);
    } finally {
      await isolated.close();
    }
  } finally {
    if (oldHost === undefined) delete process.env.PGHOST;
    else process.env.PGHOST = oldHost;

    if (oldDb === undefined) delete process.env.PGDATABASE;
    else process.env.PGDATABASE = oldDb;
  }
}

async function checkPostgres(run: Run, admin: SQL, table: string, prefix: string) {
  const sequence = `${prefix}_seq`;
  await admin.unsafe(`CREATE SEQUENCE ${sequence}`);

  try {
    for (const sql of [`SELECT nextval('${sequence}')`, `SELECT * FROM ${table} FOR UPDATE`])
      await Promise.resolve(expect(run(sql)).rejects.toMatchObject({ code: "E-DATA-READ-ONLY" }));
    await Promise.resolve(
      expect(
        run(`WITH changed AS (UPDATE ${table} SET v=99 RETURNING *) SELECT * FROM changed`)
      ).rejects.toBeInstanceOf(Error)
    );

    const uncalled = await admin.unsafe<Array<{ is_called: boolean }>>(
      `SELECT is_called FROM ${sequence}`
    );

    expect(uncalled[0]!.is_called).toBe(false);

    for (const [sql, value] of [
      ["SELECT ';' AS value; /* tail */", ";"],
      ["SELECT $$; COMMIT; UPDATE probe$$;", "; COMMIT; UPDATE probe"],
      ["SELECT $tag$;$tag$; -- tail", ";"],
      ["SELECT 1 /* outer /* nested ; */ done */;", 1],
    ] as const)
      expect((await run(sql)).rows).toEqual([[value]]);
  } finally {
    await admin.unsafe(`DROP SEQUENCE IF EXISTS ${sequence}`);
  }
}
