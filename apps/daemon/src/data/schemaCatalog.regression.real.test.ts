/** Real catalog regressions for RSD C2-C7; each case owns and drops a unique database. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { DataPools } from "./pools.ts";
import { readCatalog } from "./catalog.ts";
import { snapshotCatalog } from "./schemaCatalog.ts";
import { compareCatalogs } from "./schemaCompare.ts";
import { disposable } from "./schemaCatalog.real.testing.ts";

for (const engine of ["postgres", "mysql"] as const) {
  const url = process.env[engine === "postgres" ? "POLARIS_TEST_PG_URL" : "POLARIS_TEST_MYSQL_URL"];
  test.skipIf(!url)(
    `${engine}: identity, wide tables, expressions, index order, objects and secret retention`,
    () =>
      disposable(engine, url!, async (db, resolved) => {
        const pools = new DataPools();
        const capture = () => Effect.runPromise(snapshotCatalog(pools, resolved));

        try {
          await db.unsafe(
            `CREATE TABLE wide (${Array.from({ length: 301 }, (_, i) => `c${i} int`).join(",")})`
          );
          await db.unsafe("CREATE TABLE legacy (id int)");
          await db.unsafe("CREATE TABLE renamed (id int)");
          await db.unsafe("CREATE TABLE partition_old (id int)");
          await db.unsafe(
            `CREATE TABLE expressions (id int PRIMARY KEY,a int,b int,name varchar(80)${engine === "mysql" ? " CHARACTER SET utf8mb4 COLLATE utf8mb4_bin" : ' COLLATE "C"'},g int GENERATED ALWAYS AS (a*2) STORED,token varchar(100) DEFAULT 'sk_live_PRIVATE_DEFAULT',CHECK(token <> 'sk_live_PRIVATE_CHECK'))`
          );
          await db.unsafe("CREATE INDEX ab ON expressions(a,b)");
          await db.unsafe("CREATE UNIQUE INDEX bi ON expressions(b,id)");
          await db.unsafe("CREATE INDEX nm ON expressions(name)");
          await db.unsafe("CREATE VIEW data_view AS SELECT id,a FROM expressions");

          if (engine === "postgres")
            await db.unsafe(
              "CREATE INDEX secret_idx ON expressions(token) WHERE token = 'sk_live_PRIVATE_INDEX'"
            );
          const before = await capture();
          const described = await Effect.runPromise(readCatalog(pools, resolved, "expressions"));

          if (!("detail" in described)) throw new Error("Expected table detail");

          for (const indexes of [
            described.detail.indexes,
            before.tables.find((t) => t.name === "expressions")!.indexes,
          ]) {
            expect(indexes.filter((index) => index.name === "ab")).toMatchObject([
              { columns: ["a", "b"], unique: false },
            ]);
            expect(indexes.filter((index) => index.name === "bi")).toMatchObject([
              { columns: ["b", "id"], unique: true },
            ]);
          }

          expect(JSON.stringify(before)).not.toContain("sk_live_PRIVATE");
          expect(before.truncated).toBe(false);
          expect(before.tables.find((t) => t.name === "wide")).toMatchObject({
            detailsTruncated: true,
          });
          expect(before.tables.find((t) => t.name === "wide")?.columns).toHaveLength(256);
          expect(
            before.tables.find((t) => t.name === "expressions")?.columns.find((c) => c.name === "g")
              ?.default
          ).toBeNull();
          await db.unsafe("DROP TABLE legacy");
          await db.unsafe("CREATE TABLE payouts (id int)");
          await db.unsafe("ALTER TABLE renamed RENAME TO renamed_new");
          await db.unsafe("DROP TABLE partition_old");
          await db.unsafe("CREATE TABLE partition_new (id int)");
          await db.unsafe(`DROP INDEX ab${engine === "mysql" ? " ON expressions" : ""}`);
          await db.unsafe("CREATE INDEX ab ON expressions(b,a)");

          if (engine === "mysql") {
            await db.unsafe("DROP INDEX nm ON expressions");
            await db.unsafe("CREATE INDEX nm ON expressions(name(4))");
            await db.unsafe(
              "ALTER TABLE expressions MODIFY g int GENERATED ALWAYS AS (a*3) STORED,MODIFY name varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,ADD stamp timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
            );
            await db.unsafe(
              "CREATE TRIGGER audit_insert BEFORE INSERT ON expressions FOR EACH ROW SET NEW.a=1"
            );
          } else {
            await db.unsafe(
              'ALTER TABLE expressions DROP COLUMN g,ADD COLUMN g int GENERATED ALWAYS AS (a*3) STORED,ALTER COLUMN name TYPE varchar(80) COLLATE "POSIX"'
            );
            await db.unsafe(
              "CREATE FUNCTION audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"
            );
            await db.unsafe(
              "CREATE TRIGGER audit_insert BEFORE INSERT ON expressions FOR EACH ROW EXECUTE FUNCTION audit_fn()"
            );
            await db.unsafe("ALTER TABLE expressions ENABLE ROW LEVEL SECURITY");
          }

          await db.unsafe("CREATE OR REPLACE VIEW data_view AS SELECT id,b AS a FROM expressions");
          const after = await capture();
          const diff = compareCatalogs(before, after);
          expect(diff.some((x) => x.kind === "removed" && x.before?.name === "legacy")).toBe(true);
          expect(diff.some((x) => x.kind === "added" && x.after?.name === "payouts")).toBe(true);
          expect(
            diff.some(
              (x) =>
                x.kind === "renamed" &&
                x.before?.name === "renamed" &&
                x.after?.name === "renamed_new"
            )
          ).toBe(true);
          expect(
            diff
              .filter(
                (x) => x.before?.name === "partition_old" || x.after?.name === "partition_new"
              )
              .map((x) => x.kind)
          ).toEqual(["removed", "added"]);
          const expression = diff.find((x) => x.after?.name === "expressions")!;
          expect(expression.columns.some((x) => x.name === "g")).toBe(true);
          expect(expression.columns.some((x) => x.name === "name")).toBe(true);
          expect(expression.indexes.find((x) => x.name === "ab")?.after?.columns).toEqual([
            "b",
            "a",
          ]);

          if (engine === "mysql")
            expect(expression.indexes.find((x) => x.name === "nm")?.after?.columns).toEqual([
              "name(4)",
            ]);
          expect(expression.constraints.some((x) => x.after?.kind === "trigger")).toBe(true);
          expect(
            diff
              .find((x) => x.after?.name === "data_view")
              ?.constraints.some((x) => x.after?.kind === "view")
          ).toBe(true);
          expect(JSON.stringify(after)).not.toContain("sk_live_PRIVATE");
        } finally {
          await pools.close();
        }
      }),
    120000
  );
}
