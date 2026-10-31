import { expect, test } from "bun:test";
import { DataSource, DataValue } from "@polaris/protocol";
import { Effect, Predicate, Redacted, Schema } from "effect";
import { makeSnapshotCatalog, type ResolvedSource } from "./schemaCatalog.ts";
import { compareCatalogs } from "./schemaCompare.ts";
import { DataPools } from "./pools.ts";
import { source } from "./schemaSnapshots.testing.ts";
import { normalizeIndexes, type CatalogRow } from "./catalog.ts";

const response = (rows: CatalogRow[]) => ({
  columns: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "text" })),
  rows: rows.map((row) =>
    Object.values(row).map((value): DataValue =>
      Schema.decodeUnknownSync(DataValue)(
        value === undefined ? null : Predicate.isObject(value) ? JSON.stringify(value) : value
      )
    )
  ),
  truncated: false,
});

for (const engine of ["postgres", "mysql"] as const)
  test(`${engine}: bounded details, generated metadata and scrubbed literals preserve comparisons`, async () => {
    let secret = "sk_live_PRIVATE_FIRST";
    let columnCount = 257;
    let query = 0;

    const tables = [
      { schema_name: "public", relation_id: "1", identity: "1", name: "t", estimate: 10, total: 1 },
    ];

    const columns = () =>
      Array.from({ length: columnCount }, (_, i) => ({
        relation_id: "1",
        name: `c${i}`,
        type: "text",
        nullable: true,
        default_value: engine === "mysql" ? secret : `'${secret}'`,
        generated_expression: `(a * 2)`,
        collation_name: "C",
        extra: "",
        pk: false,
        fk: null,
      }));

    const capture = makeSnapshotCatalog(() =>
      Effect.sync(() => {
        const sets: CatalogRow[][] = [
          tables,
          columns(),
          [],
          [
            {
              relation_id: "1",
              name: "c",
              kind: "check",
              definition: `CHECK(token <> '${secret}')`,
            },
          ],
          [{ relation_id: "1", name: "view", kind: "view", definition: `SELECT '${secret}'` }],
          engine === "postgres" ? [{ total: 1 }] : [{ name: "public/t", identity: "1" }],
        ];

        return response(sets[query++ % 6]!);
      })
    );

    const resolved: ResolvedSource = {
      source: new DataSource({ ...Schema.encodeSync(DataSource)(source), engine }),
      connection: {
        hostname: "localhost",
        port: 5432,
        database: "app",
        username: "user",
        password: Redacted.make("db-secret"),
        tls: false,
      },
      matchUrl: Redacted.make("postgres://user@localhost/app"),
    };

    const pools = new DataPools();

    try {
      const before = await Effect.runPromise(capture(pools, resolved));
      expect(before.truncated).toBe(false);
      expect(before.tables[0]?.columns).toHaveLength(256);
      expect(before.tables[0]?.detailsTruncated).toBe(true);
      expect(before.tables[0]?.columns[0]).toMatchObject({ generated: "(a * 2)", collation: "C" });
      expect(JSON.stringify(before)).not.toContain(secret);
      secret = "sk_live_PRIVATE_SECOND";
      columnCount = 256;
      const after = await Effect.runPromise(capture(pools, resolved));
      expect(after.tables[0]?.detailsTruncated).toBeUndefined();
      expect(compareCatalogs(before, after)[0]?.columns.length).toBe(256);
      expect(JSON.stringify(after)).not.toContain(secret);
    } finally {
      await pools.close();
    }
  });

test("MySQL index normalization uses ordinal key order and preserves prefixes and direction", () => {
  expect(
    normalizeIndexes(
      [
        {
          relation_id: "t",
          name: "ab",
          position: 2,
          column_name: "b(4) DESC",
          is_unique: false,
          definition: "BTREE",
        },
        {
          relation_id: "t",
          name: "ab",
          position: 1,
          column_name: "a",
          is_unique: false,
          definition: "BTREE",
        },
      ],
      "mysql"
    )[0]?.columns
  ).toEqual(["a", "b(4) DESC"]);
});
