/**
 * Opt-in: the Table tab's SQL on real servers (RU2 F1, F2, F10, F11). Never point these URLs at a
 * database holding user data; each run makes and drops its own uf2_* schema (MySQL: database).
 *
 *   POLARIS_TEST_PG_URL=postgres://… POLARIS_TEST_MYSQL_URL=mysql://… bun test sql.real.test.ts
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { type Engine, identFor, keyFilter, quoteIdent, type TableRef, tableSql } from "./sql.ts";

const ROWS = 5_000;

const Ids = Schema.Array(Schema.Struct({ id: Schema.Number }));

const urls: Readonly<Record<Exclude<Engine, "sqlite">, string | undefined>> = {
  postgres: process.env["POLARIS_TEST_PG_URL"],
  mysql: process.env["POLARIS_TEST_MYSQL_URL"],
};

const ENGINES = ["postgres", "mysql"] as const;

for (const engine of ENGINES) {
  const url = urls[engine];

  describe.skipIf(url === undefined)(`the Table tab's SQL on ${engine}`, () => {
    // One connection, so a session's sql_mode holds for the MySQL escape check.
    const sql = new SQL({ url: url ?? "", max: 1 });
    const schema = `uf2_${Date.now().toString(36)}_billing`;
    const table: TableRef = { schema, name: "invoices" };
    const q = (name: string) => quoteIdent(engine, name);

    const read = (text: string) => sql.begin("read only", (tx) => tx.unsafe(text));

    /** The ids on one page of the Table tab's query. */
    const page = async (filter: string, offset: number, limit = 1_000) => {
      const rows: unknown = await read(
        tableSql({ engine, table, filter, orderBy: ["id"], limit, offset })
      );

      return Schema.decodeUnknownSync(Ids)(rows).map((r) => r.id);
    };

    beforeAll(async () => {
      await sql.unsafe(`CREATE ${engine === "postgres" ? "SCHEMA" : "DATABASE"} ${q(schema)}`);
      await sql.unsafe(
        `CREATE TABLE ${q(schema)}.${q("invoices")} (id int PRIMARY KEY, kind text, ${q("createdAt")} text, note text)`
      );

      for (let start = 1; start <= ROWS; start += 1_000) {
        const values = Array.from({ length: 1_000 }, (_, i) => {
          const id = start + i;

          return `(${id}, '${id % 2 === 0 ? "refund" : "sale"}', 'day ${id}', NULL)`;
        });

        await sql.unsafe(`INSERT INTO ${q(schema)}.${q("invoices")} VALUES ${values.join(", ")}`);
      }

      const slot = engine === "postgres" ? "$1" : "?";

      await sql.unsafe(`UPDATE ${q(schema)}.${q("invoices")} SET note = ${slot} WHERE id = 7`, [
        "a\\b",
      ]);
    });

    afterAll(async () => {
      await sql.unsafe(
        `DROP ${engine === "postgres" ? "SCHEMA" : "DATABASE"} ${q(schema)}${engine === "postgres" ? " CASCADE" : ""}`
      );
      await sql.close();
    });

    test("a table outside the default schema is read by schema and name (F1)", async () => {
      expect(await page("", 0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test("a -- comment in the filter keeps the page to its LIMIT and OFFSET (F2)", async () => {
      const ids = await page("kind = 'refund' -- refunds only", 1_000);

      expect([ids.length, ids[0], ids.at(-1)]).toEqual([1_000, 2_002, 4_000]);
    });

    test("an OR in the filter stays inside its parentheses (F2)", async () => {
      expect(await page("kind = 'refund' or kind = 'sale'", 4_990)).toHaveLength(10);
    });

    test("a completed mixed-case column runs as the engine spells it (F11)", async () => {
      expect(await page(`${identFor(engine, "createdAt")} = 'day 3'`, 0)).toEqual([3]);
    });

    test("a followed key with a backslash matches whatever the escape mode (F10)", async () => {
      const followed = keyFilter(engine, "note", "a\\b");

      if (!("filter" in followed)) throw new Error(followed.reason);
      const modes = engine === "mysql" ? ["", "NO_BACKSLASH_ESCAPES"] : [""];
      const found: Array<number> = [];

      for (const mode of modes) {
        if (engine === "mysql") await sql.unsafe(`SET SESSION sql_mode = '${mode}'`);
        found.push(...(await page(followed.filter, 0)));
      }

      expect(found).toEqual(modes.map(() => 7));
    });
  });
}
