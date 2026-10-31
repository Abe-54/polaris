import { expect, test } from "bun:test";
import { DataSource } from "@polaris/protocol";
import { writeParams } from "./writeRedaction.ts";
import { writePlan } from "./writeSql.ts";
import type { LexicalMode } from "./guard.ts";

for (const engine of ["postgres", "mysql"] as const) {
  const mode: LexicalMode = { engine, standardConformingStrings: true, sqlMode: "" };

  const source = new DataSource({
    id: "s",
    name: "app",
    engine,
    host: "localhost",
    port: 5432,
    database: "app",
    locality: "local",
    foundIn: { kind: "manual" },
    access: "read",
    writes: "ask",
    label: { text: "", colour: "none" },
  });

  const quote = engine === "postgres" ? '"' : "`";
  const p = (i: number) => (engine === "postgres" ? `$${i}` : "?");

  const scrub = (sql: string, params: ReadonlyArray<string | number>) =>
    writeParams(writePlan(sql, source, mode), mode, params, []);

  test(`${engine} RRV F13: credential assignment expressions scrub bindings, preserving unrelated params`, () => {
    expect(
      scrub(
        `UPDATE users SET v=${p(1)},${quote}password_hash${quote}=concat(${p(2)},${p(3)}) WHERE id=${p(4)}`,
        [1, "private-a", "private-b", 4]
      )
    ).toEqual([1, "[redacted]", "[redacted]", 4]);
    expect(
      scrub(
        `INSERT INTO users(v,api_token) VALUES(${p(1)},concat(${p(2)},'x')),(${p(3)},${p(4)})`,
        [1, "private-a", 2, "private-b"]
      )
    ).toEqual([1, "[redacted]", 2, "[redacted]"]);
    expect(scrub(`INSERT INTO users SELECT ${p(1)},${p(2)}`, [1, "private"])).toEqual([
      "[redacted]",
      "[redacted]",
    ]);
  });
}

test("Postgres RRV F13: a reused binding stays redacted at every occurrence", () => {
  const mode = { engine: "postgres" as const, standardConformingStrings: true };

  const source = new DataSource({
    id: "s",
    name: "app",
    engine: "postgres",
    host: "localhost",
    port: 5432,
    database: "app",
    locality: "local",
    foundIn: { kind: "manual" },
    access: "read",
    writes: "ask",
    label: { text: "", colour: "none" },
  });

  const plan = writePlan("UPDATE users SET password_hash=$2,v=$1 WHERE id=$2", source, mode);
  expect(writeParams(plan, mode, [1, "private"], [])).toEqual([1, "[redacted]"]);
});
