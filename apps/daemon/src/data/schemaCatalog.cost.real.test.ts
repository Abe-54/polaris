/** Opt-in RSD C1: unique disposable database, no production or shared-table mutations. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { DataPools } from "./pools.ts";
import { makeSnapshotCatalog } from "./schemaCatalog.ts";
import { disposable } from "./schemaCatalog.real.testing.ts";
import { readEffect } from "./execution.ts";

for (const engine of ["postgres", "mysql"] as const) {
  const url = process.env[engine === "postgres" ? "POLARIS_TEST_PG_URL" : "POLARIS_TEST_MYSQL_URL"];
  test.skipIf(!url)(
    `C1 ${engine}: capture cost for 500 and 5000 tables`,
    () =>
      disposable(engine, url!, async (db, resolved) => {
        const pools = new DataPools();
        let queries = 0;

        const capture = makeSnapshotCatalog((...args) => {
          queries++;

          return readEffect(...args);
        });

        try {
          for (let i = 0; i < 5000; i++) {
            const columns = Array.from({ length: 11 }, (_, c) => `c${c} varchar(255)`).join(",");
            await db.unsafe(
              `CREATE TABLE t_${String(i).padStart(5, "0")} (id bigint PRIMARY KEY,${columns},CHECK (c0<>''))`
            );
            await db.unsafe(`CREATE INDEX i_${i} ON t_${String(i).padStart(5, "0")}(c1)`);

            if (i !== 499 && i !== 4999) continue;
            queries = 0;
            const start = performance.now();
            const snapshot = await Effect.runPromise(capture(pools, resolved));
            console.log(
              `C1 ${engine} ${i + 1} tables: ${Math.round(performance.now() - start)} ms, ${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KiB JSON, ${snapshot.tables.length} tables, truncated=${snapshot.truncated}, queries=${queries}`
            );
            expect(snapshot.tables).toHaveLength(500);
            expect(snapshot.truncated).toBe(i === 4999);
            expect(queries).toBeLessThanOrEqual(6);
          }
        } finally {
          await pools.close();
        }
      }),
    900000
  );
}
