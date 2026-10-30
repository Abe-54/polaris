import { connect, describe, emit, engine, observe, single } from "./report.mjs";

export async function types(sql) {
  const statement = "SELECT * FROM type_probe";
  for (const mode of ["default-first", "default-reused", "values", "raw", "simple-raw"]) {
    const query = single(sql, statement);
    if (mode === "values") query.values();
    if (mode === "raw") query.raw();
    if (mode === "simple-raw") query.simple().raw();
    const rows = await query;
    emit(`types-${mode}`, { statements: [statement], values: Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, describe(value)])), columns: rows.columns });
  }
  await observe("types-unprepared-text", ['new SQL(url, { prepare: false })', statement], async () => {
    const textSql = connect({ prepare: false });
    try {
      const textRows = await textSql.unsafe(statement).raw();
      return { values: textRows[0].map(value => value === null ? null : Buffer.from(value).toString("utf8")), columns: textRows.columns };
    } finally { await textSql.close(); }
  });
  const bigSql = connect({ bigint: true });
  const big = await bigSql.unsafe("SELECT big FROM type_probe");
  emit("types-bigint-option", { value: describe(big[0].big) });
  await bigSql.close();
  const empty = await sql.unsafe("SELECT * FROM type_probe WHERE 1=0").values();
  const duplicate = await sql.unsafe("SELECT 1 AS same, 2 AS same").values();
  emit("metadata-empty-duplicate", { emptyColumns: empty.columns, duplicateColumns: duplicate.columns, duplicateRows: [...duplicate] });
  if (engine === "postgres") {
    const oids = [...new Set(empty.columns.map(column => column.type))];
    const statement = `SELECT oid,typname,format_type(oid,NULL) AS display FROM pg_type WHERE oid IN (${oids.join(",")}) ORDER BY oid`;
    emit("metadata-oid-names", { statements: [statement], rows: [...await sql.unsafe(statement)] });
  }
}
