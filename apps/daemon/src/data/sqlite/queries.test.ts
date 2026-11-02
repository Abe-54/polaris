/** SQLite reads, catalog and refused writes through the real DataQueries on temp files. */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DataError, DataValueTags, SchemaTree, TableDetail } from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import { DataQueries } from "../index.ts";
import { sqliteRead } from "./client.ts";
import { openReadOnly } from "./jobs.ts";
import {
  rowCount,
  seedDatabase,
  seeded,
  sessionId,
  sqliteServices,
  tempDir,
  turn,
  write,
} from "./sqlite.testing.ts";

/** A checkout whose `app` source is `app.db` in it, with DataQueries over it. */
const withApp = <A, E>(
  body: (queries: DataQueries["Service"], file: string) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* tempDir("sq-query-");
        const file = join(checkout, "app.db");
        seedDatabase(file);
        write(checkout, ".env", "DATABASE_URL=file:./app.db\n");

        return yield* Effect.gen(function* () {
          yield* seeded(checkout);

          return yield* body(yield* DataQueries, file);
        }).pipe(Effect.provide(sqliteServices(checkout)));
      })
    )
  );

const agent = { sessionId, source: "app", tool: "query", turn } as const;

test("an agent query reads a Local file without approval, capped at 200 rows, with exact values", () =>
  withApp((queries) =>
    Effect.gen(function* () {
      const result = yield* queries.query({
        ...agent,
        sql: "SELECT id, big, raw, body, id AS id FROM items ORDER BY id",
      });

      expect(result.truncated).toBe(true);
      expect(result.columns.map((column) => [column.name, column.type])).toEqual([
        ["id", "integer"],
        ["big", "integer"],
        ["raw", "blob"],
        ["body", "text"],
        ["id", "integer"],
      ]);
      expect(result.rows[0]!.slice(0, 3)).toEqual([
        1,
        DataValueTags.cases.BigInt.make({ value: "9007199254740993" }),
        DataValueTags.cases.Bytes.make({ length: 3, base64: "AQIB" }),
      ]);
      expect(Predicate.isTagged(result.rows[0]![3], "Truncated")).toBe(true);
      expect(result.rows[0]![3]).toMatchObject({ bytes: 20000 });

      const ids = yield* queries.query({ ...agent, sql: "SELECT id FROM items ORDER BY id" });

      expect([ids.returned, ids.truncated, ids.rows.at(-1)]).toEqual([200, true, [200]]);
    })
  ));

test("the database enforces read-only: every job's handle refuses writes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const file = join(yield* tempDir("sq-ro-"), "app.db");
        seedDatabase(file);
        const db = openReadOnly(file);

        try {
          expect(() => db.run("DELETE FROM items")).toThrow("attempt to write a readonly database");
        } finally {
          db.close();
        }

        expect(rowCount(file)).toBe(300);
      })
    )
  ));

test("a write that starts with a read keyword is refused as a write", () =>
  withApp((queries, file) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        queries.query({
          ...agent,
          sql: "WITH one AS (SELECT 1) INSERT INTO items (name) SELECT 'sneaky' FROM one",
        })
      );

      expect(error).toMatchObject({ code: "E-DATA-READ-ONLY" });
      expect(rowCount(file)).toBe(300);
    })
  ));

test.each([
  ["VACUUM INTO a new file", (dir: string) => `VACUUM INTO '${join(dir, "copy.db")}'`],
  ["a second statement", () => "SELECT 1; DELETE FROM items"],
  ["ATTACH", (dir: string) => `ATTACH DATABASE '${join(dir, "other.db")}' AS other`],
])("query refuses %s before it runs", (_name, sql) =>
  withApp((queries, file) =>
    Effect.gen(function* () {
      const dir = join(file, "..");
      const error = yield* Effect.flip(queries.query({ ...agent, sql: sql(dir) }));

      expect(error).toMatchObject({ code: "E-DATA-READ-ONLY" });
      expect(rowCount(file)).toBe(300);
      expect(existsSync(join(dir, "copy.db")) || existsSync(join(dir, "other.db"))).toBe(false);
    })
  )
);

test("execute and grid edits are refused for SQLite with a typed reason, and nothing changes", () =>
  withApp((queries, file) =>
    Effect.gen(function* () {
      const execute = yield* Effect.flip(
        queries.execute({
          sessionId,
          source: "app",
          tool: "execute",
          turn,
          sql: "DELETE FROM items",
          reason: "Clear the table",
        })
      );

      const edits = yield* Effect.flip(
        queries.commitEdits({
          sessionId,
          source: "app",
          table: { schema: "main", name: "items" },
          primaryKey: ["id"],
          edits: [{ key: [1], column: "name", before: "item 1", value: "renamed" }],
        })
      );

      for (const error of [execute, edits]) {
        expect(error).toBeInstanceOf(DataError);
        expect(error).toMatchObject({ code: "E-DATA-READ-ONLY" });
        expect(error.message).toBe("SQLite data sources are read-only in Polaris.");
      }

      expect(rowCount(file)).toBe(300);
    })
  ));

test("describe reads the schema tree and a table's keys, foreign keys and indexes", () =>
  withApp((queries) =>
    Effect.gen(function* () {
      const tree = yield* queries.describe({ ...agent, tool: "describe" });

      if (!(tree instanceof SchemaTree)) throw new Error("expected a schema tree");
      const main = tree.schemas[0]!;

      expect(tree.schemas.map((schema) => schema.name)).toEqual(["main"]);
      expect(main.tables.map((table) => [table.name, table.columnCount])).toEqual([
        ["items", 5],
        ["notes", 3],
      ]);
      expect(main.views.map((view) => view.name)).toEqual(["item_names"]);

      const notes = yield* queries.describe({
        ...agent,
        tool: "describe",
        table: "main.notes",
        sample: 2,
      });

      if (!(notes instanceof TableDetail)) throw new Error("expected a table");

      expect(notes.primaryKey).toEqual(["id"]);
      expect(notes.columns.find((column) => column.name === "item_id")?.fk).toEqual({
        schema: "main",
        table: "items",
        column: "id",
      });
      expect(notes.columns.find((column) => column.name === "text")?.default).toBe("'none'");
      expect(notes.sample?.columns.map((column) => column.name)).toEqual(["id", "item_id", "text"]);

      const items = yield* queries.describe({ ...agent, tool: "describe", table: "items" });

      if (!(items instanceof TableDetail)) throw new Error("expected a table");

      expect(items.indexes.map((index) => [index.name, index.columns, index.unique])).toEqual([
        ["items_name", ["name"], true],
      ]);

      const missing = yield* Effect.flip(
        queries.describe({ ...agent, tool: "describe", table: "nope" })
      );

      expect(missing).toMatchObject({ code: "E-DATA-SQL" });
    })
  ));

test.each(['"main"."notes"', '"notes"', 'main."notes"', "MAIN.notes"])(
  "describe finds a table named as the Desktop App and agents quote it: %s",
  (table) =>
    withApp((queries) =>
      Effect.gen(function* () {
        const detail = yield* queries.describe({ ...agent, tool: "describe", table });

        if (!(detail instanceof TableDetail)) throw new Error("expected a table");
        expect(detail.name).toBe("notes");
      })
    )
);

test.each(['"other"."notes"', '"main"."notes"x', '"main".', '"notes'])(
  "describe refuses a name that isn't one of this file's tables: %s",
  (table) =>
    withApp((queries) =>
      Effect.gen(function* () {
        const missing = yield* Effect.flip(queries.describe({ ...agent, tool: "describe", table }));

        expect(missing).toMatchObject({ code: "E-DATA-SQL" });
      })
    )
);

test("a runaway query is stopped at its deadline", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir("sq-timeout-");
        const file = join(dir, "app.db");
        seedDatabase(file);
        const started = performance.now();

        const error = yield* Effect.flip(
          sqliteRead(file, {
            sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
            limit: 1,
            timeoutMs: 500,
          })
        );

        expect(error).toMatchObject({ code: "E-DATA-TIMEOUT" });
        expect(performance.now() - started).toBeLessThan(5000);
      })
    )
  ));
