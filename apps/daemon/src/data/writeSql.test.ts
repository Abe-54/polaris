import { expect, test } from "bun:test";
import { DataSource } from "@polaris/protocol";
import { bindValues } from "./execution.ts";
import { writePlan } from "./writeSql.ts";
import { whereParams, checkPreviewKeys } from "./writeExecution.ts";

const source = (engine: "postgres" | "mysql", locality: "local" | "remote" = "local") =>
  new DataSource({
    id: "test",
    name: "test",
    engine,
    host: "localhost",
    port: 5432,
    database: "db",
    user: "u",
    locality,
    foundIn: { kind: "manual" },
    access: "read",
    writes: "ask",
    label: { text: "", colour: "none" },
  });

test("preview parameters retain values and rebind WHERE positions without literal interpolation", () => {
  const mode = { engine: "postgres", standardConformingStrings: true } as const;

  const plan = writePlan(
    "UPDATE items SET v=$1 WHERE id=$2 AND note='$3' AND other=$2",
    source("postgres"),
    mode
  );

  const selected = whereParams(plan, mode, [30, 1]);
  expect(selected).toEqual({ sql: "WHERE id=$1 AND note='$3' AND other=$2", params: [1, 1] });
  expect(bindValues(selected.params, "postgres")).toEqual([1, 1]);
  expect(bindValues([30, 1], "postgres")).toEqual([30, 1]);
});

test("MySQL preview bindings skip SET placeholders and keep quoted question marks", () => {
  const mode = { engine: "mysql", sqlMode: "NO_BACKSLASH_ESCAPES" } as const;
  const plan = writePlan("UPDATE items SET v=?,note='?' WHERE id=?", source("mysql"), mode);
  expect(whereParams(plan, mode, [30, 1])).toEqual({ sql: "WHERE id=?", params: [1] });
});

test("write guard refuses transaction escapes, remote DDL and MySQL implicit commits", () => {
  for (const engine of ["postgres", "mysql"] as const) {
    const mode = { engine, standardConformingStrings: true, sqlMode: "NO_BACKSLASH_ESCAPES" };
    expect(() => writePlan("UPDATE items SET v=1; COMMIT", source(engine), mode)).toThrow();
    expect(() => writePlan("COMMIT", source(engine), mode)).toThrow();
    expect(() => writePlan("CREATE TABLE items (id int)", source(engine, "remote"), mode)).toThrow(
      "DDL is only available on local"
    );
  }

  expect(() =>
    writePlan("CREATE TABLE items (id int)", source("mysql"), { engine: "mysql", sqlMode: "" })
  ).toThrow("MySQL commits DDL implicitly");
});

test("subqueries retain the explicit target and only the outer WHERE is previewed", () => {
  const mode = { engine: "postgres", standardConformingStrings: true } as const;

  const plan = writePlan(
    "UPDATE items SET v=(SELECT max(v) FROM other WHERE id=$1) WHERE id IN (SELECT id FROM other WHERE v=$2)",
    source("postgres"),
    mode
  );

  expect(plan.target).toEqual({ table: "items" });
  expect(whereParams(plan, mode, [7, 9])).toEqual({
    sql: "WHERE id IN (SELECT id FROM other WHERE v=$1)",
    params: [9],
  });
  expect(
    writePlan("INSERT INTO items SELECT * FROM other", source("postgres"), mode).target
  ).toEqual({ table: "items" });
  expect(() =>
    writePlan("UPDATE items SET v=other.v FROM other", source("postgres"), mode)
  ).toThrow("UPDATE FROM");
});

import { editStatements } from "./writeEdits.ts";
import { SessionId } from "@polaris/protocol";

test("grid cells for one primary key form one statement and keep identifiers out of bind values", () => {
  const statements = editStatements(
    {
      sessionId: SessionId.make("s"),
      source: "app",
      table: { schema: "public", name: 'a"b' },
      primaryKey: ["id"],
      edits: [
        { key: [1], column: "v", before: 1, value: 2 },
        { key: [1], column: "other", before: null, value: "x" },
        { key: [2], column: "v", before: 1, value: 3 },
      ],
    },
    "postgres"
  );

  expect(statements).toEqual([
    {
      sql: 'UPDATE "public"."a""b" SET "v"=$1, "other"=$2 WHERE "id"=$3',
      params: [2, "x", 1],
      key: [1],
      before: [
        { column: "v", sent: "v", value: 1 },
        { column: "other", sent: "other", value: null },
      ],
      where: '"id"=$1',
    },
    {
      sql: 'UPDATE "public"."a""b" SET "v"=$1 WHERE "id"=$2',
      params: [3, 2],
      key: [2],
      before: [{ column: "v", sent: "v", value: 1 }],
      where: '"id"=$1',
    },
  ]);
});

test("execute rejects cross-connection writes, signals and session locks", () => {
  const calls = {
    postgres: [
      "dblink_exec('dbname=x','UPDATE x SET v=1')",
      "pg_terminate_backend(1)",
      "pg_advisory_lock(1)",
    ],
    mysql: ["GET_LOCK('x',0)", "BENCHMARK(10,1)", "SLEEP(1)", "(@x := 1)"],
  };

  for (const engine of ["postgres", "mysql"] as const)
    for (const call of calls[engine])
      expect(() =>
        writePlan(`UPDATE items SET v=${call}`, source(engine), {
          engine,
          standardConformingStrings: true,
          sqlMode: "",
        })
      ).toThrow();
});

test("clipped or omitted primary keys refuse write targeting before mutation", () => {
  const complete = Object.assign([[new TextEncoder().encode("key")]], {
    columns: [{ name: "id", type: 25 }],
  });

  expect(() => checkPreviewKeys(complete, ["id"])).not.toThrow();
  expect(() => checkPreviewKeys(complete, ["missing"])).toThrow("primary key");

  const clipped = Object.assign([[null]], {
    columns: [{ name: "id", type: 25 }],
    clipped: new Map([["0:0", { preview: "key", bytes: 4000 }]]),
  });

  expect(() => checkPreviewKeys(clipped, ["id"])).toThrow("primary key");
});
