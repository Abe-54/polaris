import assert from "node:assert/strict";
import { connect, emit, engine, single } from "./report.mjs";

const sql = connect();
const mode = process.argv[3];
await sql.unsafe("SELECT 1");
Bun.gc(true);
const before = process.memoryUsage();
const highBefore = process.resourceUsage().maxRSS;
const start = performance.now();
let count = 0;
let retained;
const statements = [];
const statement = "SELECT id, payload FROM million";
if (mode.startsWith("cursor")) {
  assert.equal(engine, "postgres");
  statements.push("BEGIN READ ONLY", `DECLARE spike_cursor NO SCROLL CURSOR FOR ${statement}`, "FETCH FORWARD 512 FROM spike_cursor", "CLOSE spike_cursor", "COMMIT");
  await sql.begin("read only", async tx => {
    await tx.unsafe(`DECLARE spike_cursor NO SCROLL CURSOR FOR ${statement}`);
    let more = true;
    while (more) {
      const rows = await tx.unsafe("FETCH FORWARD 512 FROM spike_cursor");
      count += rows.length;
      more = rows.length > 0 && mode !== "cursor-cap";
    }
    await tx.unsafe("CLOSE spike_cursor");
  });
} else {
  const actual = mode === "limit" ? `SELECT * FROM (${statement}) AS polaris_capped LIMIT 201` : statement;
  statements.push(actual);
  const query = single(sql, actual);
  if (mode === "values") query.values();
  if (mode === "raw") query.raw();
  retained = await query;
  count = retained.length;
}
const after = process.memoryUsage();
emit(`memory-${mode}`, { statements, count, ms: performance.now() - start, before, after, maxRssKiB: process.resourceUsage().maxRSS, initialMaxRssKiB: highBefore, retainedRows: retained?.length ?? 0 });
assert.equal(count, mode === "limit" ? 201 : mode === "cursor-cap" ? 512 : 1000000);
await sql.close();
