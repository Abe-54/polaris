import { connect, engine, emit, observe, query, single } from "./report.mjs";

export async function protocol() {
  const variants = {
    "unsafe-default": (sql, text) => sql.unsafe(text),
    "unsafe-empty-params": (sql, text) => sql.unsafe(text, []),
    "unsafe-third-prepare": (sql, text) => sql.unsafe(text, [], { prepare: true }),
    "tagged-unsafe-fragment": single,
    "connection-prepare": (sql, text) => sql.unsafe(text),
    "connection-multipleStatements-false": (sql, text) => sql.unsafe(text),
  };
  for (const [name, run] of Object.entries(variants)) {
    const options = name === "connection-prepare" ? { prepare: true } : name === "connection-multipleStatements-false" ? { multipleStatements: false } : {};
    const sql = connect(options);
    for (const statement of ["SELECT 1; UPDATE probe SET v=71 WHERE id=1", "SELECT 1; COMMIT; UPDATE probe SET v=72 WHERE id=1"]) {
      await sql.unsafe("UPDATE probe SET v=0");
      await observe(`protocol-${name}`, ['sql.begin("read only")', statement], () => sql.begin("read only", async tx => [...await run(tx, statement)]));
      await query(sql, `protocol-${name}-postcondition`, "SELECT * FROM probe");
    }
    await sql.unsafe("UPDATE probe SET v=0");
    await sql.close();
  }
  const sql = connect();
  const rows = await single(sql, "SELECT * FROM type_probe").raw();
  emit("protocol-tagged-raw", { engine, columns: rows.columns, hex: rows[0].map(value => value === null ? null : Buffer.from(value).toString("hex")) });
  await sql.close();
}

if (import.meta.main) await protocol();
