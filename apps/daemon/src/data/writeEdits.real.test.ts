/** Grid commits on native databases: JSON stays JSON, conflicts refuse, declared key order. */
import { expect, test } from "bun:test";
import { DataEditConflict, DataValueTags, SessionId, TableDetail } from "@polaris/protocol";
import { Effect } from "effect";
import { readCatalog } from "./catalog.ts";
import { executeRead } from "./execution.ts";
import { executeEdits } from "./writeExecution.ts";
import { databaseUrl, writeFixture } from "./writeFixes.testing.ts";

type Edits = Parameters<typeof executeEdits>[1]["edits"]["edits"];

for (const engine of ["postgres", "mysql"] as const)
  test.skipIf(!databaseUrl(engine))(
    `${engine} EF: JSON binds as JSON, conflicts and missing rows refuse, key order and float keys`,
    async () => {
      const f = writeFixture(engine, "ef");
      const { admin, name: t, source, connection, signal, pools, write } = f;
      const schema = engine === "postgres" ? "public" : source.database;
      const p = (n: number) => (engine === "postgres" ? `$${n}` : "?");

      const commit = (name: string, edits: Edits, primaryKey = ["id"]) =>
        executeEdits(
          pools,
          {
            source,
            connection,
            edits: {
              sessionId: SessionId.make("ef"),
              source: source.id,
              table: { schema, name },
              primaryKey,
              edits,
            },
          },
          signal
        );

      const read = async (sql: string) =>
        (await executeRead(pools, { source, connection, sql, limit: 10 }, signal)).rows;

      const rows = async (sql: string) =>
        Array.from(await admin.unsafe<Array<Record<string, string | number | null>>>(sql));

      try {
        // F1: a JSON edit stores the document, not a JSON string holding it.
        const jsonColumns = engine === "postgres" ? "j jsonb,k json" : "j json,k json";
        await admin.unsafe(`CREATE TABLE ${t}_json(id int PRIMARY KEY,${jsonColumns})`);
        await admin.unsafe(`INSERT INTO ${t}_json VALUES(1,'{}','{}'),(2,'{}','{}')`);
        const [seen] = await read(`SELECT j,k FROM ${t}_json WHERE id=1`);

        const doc = DataValueTags.cases.Json.make({
          text: '{"a": 12345678901234567890, "b": [1]}',
        });

        await commit(`${t}_json`, [
          { key: [1], column: "j", before: seen![0]!, value: doc },
          { key: [1], column: "k", before: seen![1]!, value: doc },
        ]);

        if (engine === "postgres") {
          expect(
            await rows(
              `SELECT jsonb_typeof(j) AS j,json_typeof(k) AS k,(j->'a')::text AS a FROM ${t}_json WHERE id=1`
            )
          ).toEqual([{ j: "object", k: "object", a: "12345678901234567890" }]);
          const preview = await write(`UPDATE ${t}_json SET j=$1 WHERE id=$2`, {}, [doc, 2]);
          await write(
            `UPDATE ${t}_json SET j=$1 WHERE id=$2`,
            { dryRun: false, expected: preview.affected, expectedIdentity: preview.identity },
            [doc, 2]
          );
          expect(await rows(`SELECT jsonb_typeof(j) AS j FROM ${t}_json WHERE id=2`)).toEqual([
            { j: "object" },
          ]);
        } else {
          expect(
            await rows(
              `SELECT JSON_TYPE(j) AS j,JSON_TYPE(k) AS k,CAST(JSON_EXTRACT(j,'$.a') AS CHAR) AS a FROM ${t}_json WHERE id=1`
            )
          ).toEqual([{ j: "OBJECT", k: "OBJECT", a: "12345678901234567890" }]);
        }

        // F2: a cell an agent changed since staging refuses the whole commit, naming the newer value.
        await admin.unsafe(`CREATE TABLE ${t}(id int PRIMARY KEY,v int,n int)`);
        await admin.unsafe(`INSERT INTO ${t} VALUES(1,10,NULL),(2,20,NULL),(3,30,NULL)`);
        await admin.unsafe(`UPDATE ${t} SET v=99 WHERE id=1`);
        await Promise.resolve(
          expect(
            commit(t, [
              { key: [1], column: "v", before: 10, value: 11 },
              { key: [2], column: "v", before: 20, value: 21 },
            ])
          ).rejects.toMatchObject({
            code: "E-DATA-CONFLICT",
            conflicts: [DataEditConflict.cases.Changed.make({ key: [1], column: "v", value: 99 })],
          })
        );
        expect(await rows(`SELECT id,v FROM ${t} ORDER BY id`)).toEqual([
          { id: 1, v: 99 },
          { id: 2, v: 20 },
          { id: 3, v: 30 },
        ]);
        expect(
          (
            await commit(t, [
              { key: [2], column: "n", before: null, value: 5 },
              { key: [2], column: "v", before: 20, value: 21 },
            ])
          ).affected
        ).toBe(1);

        // Committed cells come back as the database stored them, so the next edit's check passes.
        await admin.unsafe(`CREATE TABLE ${t}_typed(id int PRIMARY KEY,i int,d numeric(10,2))`);
        await admin.unsafe(`INSERT INTO ${t}_typed VALUES(1,0,0)`);
        const [typedRow] = await read(`SELECT i,d FROM ${t}_typed`);

        const typed = await commit(`${t}_typed`, [
          {
            key: [1],
            column: "i",
            before: typedRow![0]!,
            value: DataValueTags.cases.Numeric.make({ value: "42" }),
          },
          {
            key: [1],
            column: "d",
            before: typedRow![1]!,
            value: DataValueTags.cases.Numeric.make({ value: "1.5" }),
          },
        ]);

        const stored = DataValueTags.cases.Numeric.make({ value: "1.50" });

        expect(typed.written).toEqual([
          { key: [1], column: "i", value: 42 },
          { key: [1], column: "d", value: stored },
        ]);
        expect(
          (await commit(`${t}_typed`, [{ key: [1], column: "d", before: stored, value: 2 }]))
            .affected
        ).toBe(1);

        // F5: a staged row that no longer exists comes back as Missing, with its key.
        await admin.unsafe(`DELETE FROM ${t} WHERE id=3`);
        await Promise.resolve(
          expect(
            commit(t, [{ key: [3], column: "v", before: 30, value: 31 }])
          ).rejects.toMatchObject({
            code: "E-DATA-CONFLICT",
            conflicts: [DataEditConflict.cases.Missing.make({ key: [3] })],
          })
        );

        // F8: a failing row's update names its key.
        await Promise.resolve(
          expect(
            commit(t, [{ key: [2], column: "v", before: 21, value: "not a number" }])
          ).rejects.toMatchObject({ code: "E-DATA-SQL", row: [2] })
        );

        // F3: a key declared out of column order is described, and commits, in declared order.
        await admin.unsafe(`CREATE TABLE ${t}_comp(a int,b int,v int,PRIMARY KEY (b,a))`);
        await admin.unsafe(`INSERT INTO ${t}_comp VALUES(1,2,0)`);

        const described = await Effect.runPromise(
          readCatalog(pools, { source, connection }, `${t}_comp`)
        );

        const detail = "detail" in described ? described.detail : null;

        expect(detail).toBeInstanceOf(TableDetail);
        expect(detail?.primaryKey).toEqual(["b", "a"]);
        expect(
          (
            await commit(
              `${t}_comp`,
              [{ key: [2, 1], column: "v", before: 0, value: 1 }],
              [...(detail?.primaryKey ?? [])]
            )
          ).affected
        ).toBe(1);

        // F14: a floating-point key can't be matched exactly, so the table is refused.
        const float = engine === "postgres" ? "real" : "FLOAT";
        await admin.unsafe(`CREATE TABLE ${t}_float(r ${float} PRIMARY KEY,v int)`);
        await admin.unsafe(`INSERT INTO ${t}_float VALUES(${p(1)},0)`, [0.1]);
        const [floatRow] = await read(`SELECT r FROM ${t}_float`);
        await Promise.resolve(
          expect(
            commit(
              `${t}_float`,
              [{ key: [floatRow![0]!], column: "v", before: 0, value: 1 }],
              ["r"]
            )
          ).rejects.toMatchObject({
            code: "E-DATA-SQL",
            message:
              "This table's primary key includes a floating-point column, so its rows can't be matched exactly.",
          })
        );
      } finally {
        await admin.unsafe(`DROP TABLE IF EXISTS ${t},${t}_json,${t}_comp,${t}_float,${t}_typed`);
        await f.close();
      }
    },
    30000
  );
