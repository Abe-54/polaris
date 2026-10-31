/** Disposable native databases exercise rollback, drift, cancellation and atomic grid edits. */
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { DataSource, SessionId } from "@polaris/protocol";
import { Redacted } from "effect";
import { parseConnection } from "./connection.ts";
import { DataPools, sqlOptions } from "./pools.ts";
import { executeWrite, executeEdits } from "./writeExecution.ts";

for (const engine of ["postgres", "mysql"] as const) {
  const url = process.env[engine === "postgres" ? "POLARIS_TEST_PG_URL" : "POLARIS_TEST_MYSQL_URL"];
  test.skipIf(!url)(
    `${engine}: write preview rolls back, drift aborts, grid commits atomically`,
    async () => {
      const parsed = parseConnection({
        name: "write-test",
        url: Redacted.make(url!),
        foundIn: { kind: "manual" },
      })!;

      const { connection } = parsed;
      const table = `polaris_w_${crypto.randomUUID().replaceAll("-", "")}`;
      const noKey = `${table}_nokey`;
      const textKey = `${table}_textkey`;

      const source = new DataSource({
        id: table,
        name: table,
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

      const admin = new SQL({
        ...sqlOptions(source, connection),
        allowPublicKeyRetrieval: engine === "mysql",
      });

      const pools = new DataPools();
      const signal = new AbortController().signal;

      const run = (
        sql: string,
        dryRun: boolean,
        expected?: number,
        params: Array<number | string> = []
      ) =>
        executeWrite(
          pools,
          {
            source,
            connection,
            sql,
            dryRun,
            params,
            ...(expected === undefined ? undefined : { expected }),
          },
          signal
        );

      const read = async () =>
        Array.from(
          await admin.unsafe<Array<{ id: number; v: number }>>(
            `SELECT id,v FROM ${table} ORDER BY id`
          )
        );

      const schema = engine === "postgres" ? "public" : source.database;

      const edits = (
        changes: Array<{ key: number[]; column: string; value: number }>,
        name = table,
        primaryKey = ["id"]
      ) =>
        executeEdits(
          pools,
          {
            source,
            connection,
            edits: {
              sessionId: SessionId.make("write-test"),
              source: table,
              table: { schema, name },
              primaryKey,
              edits: changes,
            },
          },
          signal
        );

      try {
        await admin.unsafe(`CREATE TABLE ${table} (id INT PRIMARY KEY,v INT NOT NULL)`);
        await admin.unsafe(`CREATE TABLE ${noKey} (id INT,v INT NOT NULL)`);
        await admin.unsafe(`INSERT INTO ${table} VALUES (1,10),(2,20)`);
        const p = engine === "postgres" ? "$1" : "?";
        const p2 = engine === "postgres" ? "$2" : "?";

        const preview = await run(
          `UPDATE ${table} SET v=${p} WHERE id=${p2}`,
          true,
          undefined,
          [30, 1]
        );

        expect(preview.affected).toBe(1);
        expect(preview.before).toEqual([[1, 10]]);
        expect(preview.after).toEqual([[1, 30]]);
        expect(await read()).toEqual([
          { id: 1, v: 10 },
          { id: 2, v: 20 },
        ]);
        expect(
          (await run(`UPDATE ${table} SET v=${p} WHERE id=${p2}`, false, preview.affected, [30, 1]))
            .affected
        ).toBe(1);
        expect(await read()).toEqual([
          { id: 1, v: 30 },
          { id: 2, v: 20 },
        ]);
        const deleting = await run(`DELETE FROM ${table} WHERE id=2`, true);
        expect(deleting.before).toEqual([[2, 20]]);
        expect(deleting.after).toEqual([]);
        expect(await read()).toHaveLength(2);
        const broad = await run(`UPDATE ${table} SET v=v+1`, true);
        await admin.unsafe(`INSERT INTO ${table} VALUES (3,30)`);
        await Promise.resolve(
          expect(run(`UPDATE ${table} SET v=v+1`, false, broad.affected)).rejects.toMatchObject({
            code: "E-DATA-SQL",
          })
        );
        expect(await read()).toEqual([
          { id: 1, v: 30 },
          { id: 2, v: 20 },
          { id: 3, v: 30 },
        ]);
        await Promise.resolve(
          expect(
            edits([
              { key: [1], column: "v", value: 40 },
              { key: [99], column: "v", value: 50 },
            ])
          ).rejects.toMatchObject({ code: "E-DATA-SQL" })
        );
        expect(await read()).toEqual([
          { id: 1, v: 30 },
          { id: 2, v: 20 },
          { id: 3, v: 30 },
        ]);
        expect(
          (
            await edits([
              { key: [1], column: "v", value: 40 },
              { key: [2], column: "v", value: 50 },
            ])
          ).affected
        ).toBe(2);
        expect(await read()).toEqual([
          { id: 1, v: 40 },
          { id: 2, v: 50 },
          { id: 3, v: 30 },
        ]);
        await Promise.resolve(
          expect(edits([{ key: [1], column: "v", value: 40 }], noKey)).rejects.toMatchObject({
            code: "E-DATA-SQL",
          })
        );
        await Promise.resolve(
          expect(run(`UPDATE ${table} SET v=0; COMMIT`, true)).rejects.toMatchObject({
            code: "E-DATA-READ-ONLY",
          })
        );
        await admin.unsafe(`CREATE TABLE ${textKey} (id VARCHAR(128) PRIMARY KEY,v INT)`);
        await admin.unsafe(`INSERT INTO ${textKey} VALUES (${p},1)`, [
          Redacted.value(connection.password),
        ]);
        const secretKeyPreview = await run(`UPDATE ${textKey} SET v=2`, true);
        expect(secretKeyPreview.before[0]?.[1]).toBe(1);
        expect(secretKeyPreview.after[0]?.[1]).toBe(2);
        expect(JSON.stringify(secretKeyPreview).includes(Redacted.value(connection.password))).toBe(
          false
        );
        await admin.unsafe(`ALTER TABLE ${table} ADD COLUMN other INT DEFAULT 0`);
        expect(
          (
            await edits([
              { key: [1], column: "v", value: 41 },
              { key: [1], column: "other", value: 9 },
            ])
          ).affected
        ).toBe(1);
        expect(
          Array.from(
            await admin.unsafe<Array<{ v: number; other: number }>>(
              `SELECT v,other FROM ${table} WHERE id=1`
            )
          )
        ).toEqual([{ v: 41, other: 9 }]);
        expect((await edits([{ key: [1], column: "v", value: 41 }])).affected).toBe(1);

        if (engine === "mysql") {
          await Promise.resolve(
            expect(run(`CREATE TABLE ${table}_ddl (id INT)`, true)).rejects.toMatchObject({
              code: "E-DATA-SQL",
            })
          );
          await admin.unsafe(`ALTER TABLE ${noKey} ENGINE=MyISAM`);
          await Promise.resolve(
            expect(run(`INSERT INTO ${noKey} VALUES (1,1)`, true)).rejects.toMatchObject({
              code: "E-DATA-SQL",
            })
          );
          expect(
            Array.from(
              await admin.unsafe<Array<{ id: number; v: number }>>(`SELECT * FROM ${noKey}`)
            )
          ).toEqual([]);
        } else {
          await run(`ALTER TABLE ${table} ADD COLUMN preview_only INT`, true);
          expect(
            Array.from(
              await admin<
                Array<{ column_name: string }>
              >`SELECT column_name FROM information_schema.columns WHERE table_name=${table} AND column_name='preview_only'`
            )
          ).toEqual([]);
        }
      } finally {
        await pools.close();
        await admin.unsafe(`DROP TABLE IF EXISTS ${table},${noKey},${textKey}`);
        await admin.close();
      }
    },
    30000
  );
}
