import { expect, test } from "bun:test";
import { DataValueTags, SessionId } from "@polaris/protocol";
import { executeEdits } from "./writeExecution.ts";
import { executeRead } from "./execution.ts";
import { databaseUrl, writeFixture } from "./writeFixes.testing.ts";

for (const engine of ["postgres", "mysql"] as const)
  test.skipIf(!databaseUrl(engine))(
    `${engine} F4/F6/F7/F9/F11/F12: insert images, drift and typed binary edits`,
    async () => {
      const f = writeFixture(engine);
      const { admin, name: t, write, source, connection, signal, pools } = f;
      const param = engine === "postgres" ? "$1" : "?";

      try {
        await admin.unsafe(`CREATE TABLE ${t}(id int PRIMARY KEY,v int,api_token varchar(64))`);
        await admin.unsafe(
          `INSERT INTO ${t} VALUES(1,1,'tok_live_secret'),(2,1,'secret'),(3,0,'other')`
        );

        const changed = await write(`UPDATE ${t} SET api_token=${param} WHERE id=1`, {}, [
          "new-private-token",
        ]);

        expect(changed.redactedCells).toEqual([{ row: 0, column: 2, changed: true }]);
        expect(changed.before[0]?.[2]).toBe("[redacted]");
        expect(changed.after[0]?.[2]).toBe("[redacted]");
        expect(changed.params).toEqual(["[redacted]"]);
        expect(changed.previewFacts).toEqual({
          capped: false,
          truncated: false,
          readByKey: true,
          sequences: false,
        });
        const unchanged = await write(`UPDATE ${t} SET api_token=api_token WHERE id=1`);
        expect(unchanged.redactedCells).toEqual([{ row: 0, column: 2, changed: false }]);
        const preview = await write(`DELETE FROM ${t} WHERE v=1`);
        expect(preview.before).toEqual([
          [1, 1, "[redacted]"],
          [2, 1, "[redacted]"],
        ]);
        await admin.unsafe(`UPDATE ${t} SET v=0 WHERE id=1`);
        await admin.unsafe(`UPDATE ${t} SET v=1 WHERE id=3`);
        await Promise.resolve(
          expect(
            write(`DELETE FROM ${t} WHERE v=1`, {
              dryRun: false,
              expected: preview.affected,
              expectedIdentity: preview.identity,
            })
          ).rejects.toMatchObject({
            code: "E-DATA-SQL",
            message:
              "The affected row identities changed after the preview. The transaction was rolled back.",
          })
        );
        expect(
          (await admin.unsafe<Array<Record<string, string | number | null>>>(`SELECT * FROM ${t}`))
            .length
        ).toBe(3);
        const insert = await write(`INSERT INTO ${t}(id,v) VALUES(4,9)`);
        expect(insert.before).toEqual([]);
        expect(insert.after).toEqual([[4, 9, "[redacted]"]]);
        expect(
          (await admin.unsafe<Array<Record<string, string | number | null>>>(`SELECT * FROM ${t}`))
            .length
        ).toBe(3);
        await write(`INSERT INTO ${t}(id,v) VALUES(4,9)`, {
          dryRun: false,
          expected: insert.affected,
          expectedIdentity: insert.identity,
        });
        await admin.unsafe(
          `CREATE TABLE ${t}_generated(id ${engine === "postgres" ? "serial" : "int AUTO_INCREMENT"} PRIMARY KEY,v int,created_at ${engine === "postgres" ? "timestamptz DEFAULT now()" : "timestamp DEFAULT CURRENT_TIMESTAMP"})`
        );
        const generated = await write(`INSERT INTO ${t}_generated(v) VALUES(7)`);
        expect(generated.after[0]?.[1]).toBe(7);
        expect(generated.databaseFilledColumns).toEqual(["id", "created_at"]);
        expect(generated.previewFacts).toMatchObject({ sequences: true, readByKey: false });
        expect(generated.note).toBe("");
        await write(`INSERT INTO ${t}_generated(v) VALUES(7)`, {
          dryRun: false,
          expected: generated.affected,
          expectedIdentity: generated.identity,
        });
        expect(
          (await admin.unsafe<Array<{ v: number }>>(`SELECT v FROM ${t}_generated`))[0]?.v
        ).toBe(7);
        await admin.unsafe(`CREATE TABLE ${t}_nokey(id int,v int)`);
        await admin.unsafe(`INSERT INTO ${t}_nokey VALUES(1,1),(2,0)`);
        const noKey = await write(`DELETE FROM ${t}_nokey WHERE v=1`);
        await admin.unsafe(`UPDATE ${t}_nokey SET v=1-v`);
        await Promise.resolve(
          expect(
            write(`DELETE FROM ${t}_nokey WHERE v=1`, {
              dryRun: false,
              expected: noKey.affected,
              expectedIdentity: noKey.identity,
            })
          ).rejects.toMatchObject({ code: "E-DATA-SQL" })
        );
        await admin.unsafe(
          `INSERT INTO ${t}(id,v) VALUES ${Array.from({ length: 25 }, (_, i) => `(${i + 10},0)`).join(",")}`
        );
        await Promise.resolve(
          expect(
            write(
              `UPDATE ${t} SET ${engine === "mysql" ? "ID" : "id"}=CASE WHEN id>20 THEN id+1000 ELSE id END`
            )
          ).rejects.toMatchObject({ code: "E-DATA-SQL" })
        );
        const capped = await write(`UPDATE ${t} SET v=0`);
        expect(capped.previewFacts).toMatchObject({ capped: true, sequences: false });
        await admin.unsafe(
          `CREATE TABLE ${t}_binary(id ${engine === "postgres" ? "bytea" : "BINARY(2)"} PRIMARY KEY,v int)`
        );
        await admin.unsafe(`INSERT INTO ${t}_binary VALUES(${param},0)`, [Buffer.from([0, 255])]);

        const result = await executeRead(
          pools,
          { source, connection, sql: `SELECT id FROM ${t}_binary`, limit: 1 },
          signal
        );

        expect(result.rows).toEqual([
          [DataValueTags.cases.Bytes.make({ length: 2, base64: "AP8=" })],
        ]);

        const edits = (
          name: string,
          changes: Parameters<typeof executeEdits>[1]["edits"]["edits"]
        ) =>
          executeEdits(
            pools,
            {
              source,
              connection,
              edits: {
                sessionId: SessionId.make("wf"),
                source: source.id,
                table: { schema: engine === "postgres" ? "public" : source.database, name },
                primaryKey: ["id"],
                edits: changes,
              },
            },
            signal
          );

        expect(
          (await edits(`${t}_binary`, [{ key: result.rows[0]!, column: "v", before: 0, value: 8 }]))
            .affected
        ).toBe(1);
        expect((await admin.unsafe<Array<{ v: number }>>(`SELECT v FROM ${t}_binary`))[0]?.v).toBe(
          8
        );
        await Promise.resolve(
          expect(
            edits(t, [
              { key: [1], column: "v", before: 0, value: 4 },
              {
                key: [DataValueTags.cases.Numeric.make({ value: "1" })],
                column: "v",
                before: 0,
                value: 5,
              },
            ])
          ).rejects.toMatchObject({ code: "E-DATA-SQL" })
        );
        expect(
          (await admin.unsafe<Array<{ v: number }>>(`SELECT v FROM ${t} WHERE id=1`))[0]?.v
        ).toBe(0);
      } finally {
        await admin.unsafe(`DROP TABLE IF EXISTS ${t},${t}_generated,${t}_nokey,${t}_binary`);
        await f.close();
      }
    },
    30000
  );
