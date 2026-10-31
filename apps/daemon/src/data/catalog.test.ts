import { expect, test } from "bun:test";
import { DataSource, DataValueTags } from "@polaris/protocol";
import { Effect, Redacted } from "effect";
import { makeCatalogReader } from "./catalog.ts";
import { catalogValues } from "./catalogValues.ts";
import { DataPools } from "./pools.ts";
import { decodeResult, type Column, type RawResult } from "./values.ts";

const source = new DataSource({
  id: "app",
  name: "app",
  engine: "mysql",
  host: "localhost",
  port: 3306,
  database: "ledger",
  user: "reader",
  locality: "local",
  foundIn: { kind: "manual" },
  access: "read",
  writes: "off",
  label: { text: "", colour: "none" },
});

const connection = {
  hostname: "localhost",
  port: 3306,
  database: "ledger",
  username: "reader",
  password: Redacted.make(""),
  tls: false as const,
};

type Cell = readonly [string, number, number, Uint8Array | null];

const txt = (name: string, value: string | null, type = 253): Cell => [
  name,
  type,
  128,
  value === null ? null : new TextEncoder().encode(value),
];

const int = (name: string, value: number): Cell => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);

  return [name, 3, 0, buffer];
};

function raw(cells: readonly Cell[]): RawResult {
  return Object.assign([cells.map((cell) => cell[3])], {
    columns: cells.map(([name, type, flags]): Column => ({ name, type, flags })),
  });
}

const tree = [
  txt("schema_name", "ledger"),
  txt("name", "orders"),
  int("view", 0),
  int("estimate", 4),
  int("column_count", 1),
  txt("columns", '[{"name":"id","type":"int"}]', 252),
  int("total", 1),
];

const routines = [txt("schema_name", "ledger"), txt("name", "routine")];

const columns = [
  txt("name", "id"),
  txt("type", "int", 252),
  int("nullable", 0),
  txt("default_value", "7", 252),
  int("pk", 1),
  txt("fk", '{"schema":"ledger","table":"parents","column":"id"}', 245),
];

const indexes = [
  txt("name", "PRIMARY"),
  txt("relation_id", "orders"),
  txt("column_name", "id"),
  int("position", 1),
  int("is_unique", 1),
  txt("definition", "BTREE"),
];

const constraints = [
  txt("name", "positive"),
  txt("kind", "CHECK"),
  txt("definition", "(`id` > 0)", 252),
];

function reader(results: readonly RawResult[]) {
  let index = 0;

  return makeCatalogReader((_pools, input) =>
    Effect.sync(() => ({
      ...decodeResult(results[index++]!, input.source.engine, [], input.catalogText),
      truncated: false,
      columns: results[index - 1]!.columns.map((column) => ({ name: column.name, type: "text" })),
    }))
  );
}

test("MySQL binary-collated catalog fields build tree and detail from Buffer/Uint8Array and JSON text arrays", async () => {
  const pools = new DataPools();
  const view = tree.map((cell) => (cell[0] === "view" ? int("view", 1) : cell));

  const catalog = await Effect.runPromise(
    reader([raw(view), raw(routines)])(pools, { source, connection })
  );

  if (!("schemas" in catalog)) throw new Error("Expected schema tree");
  expect(catalog.schemas[0]).toMatchObject({
    name: "ledger",
    tables: [],
    functions: ["routine"],
    views: [{ name: "orders", columnCount: 1, columns: [{ name: "id", type: "int" }] }],
  });

  const result = await Effect.runPromise(
    reader([tree, routines, columns, indexes, constraints].map(raw))(
      pools,
      { source, connection },
      "orders"
    )
  );

  if (!("detail" in result)) throw new Error("Expected table detail");
  expect(result.detail).toMatchObject({
    schema: "ledger",
    name: "orders",
    rowEstimate: 4,
    columns: [
      {
        name: "id",
        type: "int",
        nullable: false,
        default: "7",
        pk: true,
        fk: { schema: "ledger", table: "parents", column: "id" },
      },
    ],
    indexes: [{ name: "PRIMARY", columns: ["id"], unique: true, definition: "BTREE" }],
    constraints: [{ name: "positive", kind: "CHECK", definition: "(`id` > 0)" }],
  });
  expect(result.sampleSql).toBe("SELECT * FROM `ledger`.`orders`");
  expect(decodeResult(raw([txt("payload", "secret bytes", 252)]), "mysql", []).rows).toEqual([
    [DataValueTags.cases.Bytes.make({ length: 12 })],
  ]);
});

for (const [position, field, replacement, expected] of [
  [0, "schema_name", int("schema_name", 1), "tables.schema_name"],
  [0, "columns", txt("columns", "secret invalid JSON"), "tables.columns"],
  [0, "view", int("view", 3), "tables.view"],
  [1, "name", int("name", 1), "functions.name"],
  [2, "default_value", int("default_value", 1), "columns.default_value"],
  [2, "fk", txt("fk", '{"password":"secret"}'), "columns.fk"],
  [3, "column_name", int("column_name", 1), "index.column"],
  [4, "definition", int("definition", 1), "constraints.definition"],
] as const)
  test(`malformed catalog ${expected} is a typed field-specific failure`, async () => {
    const results = [tree, routines, columns, indexes, constraints].map((cells, i) =>
      raw(cells.map((cell) => (i === position && cell[0] === field ? replacement : cell)))
    );

    const error = await Effect.runPromise(
      Effect.flip(reader(results)(new DataPools(), { source, connection }, "orders"))
    );

    expect(error).toMatchObject({
      code: "E-DATA-SQL",
      message: `Could not decode mysql catalog field ${expected}.`,
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  });

for (const engine of ["postgres", "mysql"] as const)
  test(`${engine} catalog accepts byte text and both JSON representations`, () => {
    const values = catalogValues(engine);
    expect(values.text("name", Buffer.from("table"))).toBe("table");
    expect(values.text("name", new TextEncoder().encode("view"))).toBe("view");
    expect(values.plain("columns", DataValueTags.cases.Json.make({ text: '["id"]' }))).toEqual([
      "id",
    ]);
    expect(() => values.text("name", 12)).toThrow(`Could not decode ${engine} catalog field name.`);
  });
