import assert from "node:assert/strict";
import { connect, emit, engine } from "./report.mjs";

export async function pooling() {
  const events = [];
  const started = performance.now();
  const sql = connect({ max: 2, idleTimeout: 1, maxLifetime: 0,
    onconnect: () => events.push({ event: "connect", ms: performance.now() - started }),
    onclose: error => events.push({ event: "close", ms: performance.now() - started, code: error?.code }),
  });
  const statement = engine === "postgres" ? "SELECT pg_backend_pid() AS id, pg_sleep(0.05)" : "SELECT CONNECTION_ID() AS id, SLEEP(0.05) AS slept";
  const rows = await Promise.all(Array.from({ length: 8 }, () => sql.begin(tx => tx.unsafe(statement))));
  const ids = [...new Set(rows.map(result => result[0].id))];
  const second = connect();
  const other = await second.unsafe(engine === "postgres" ? "SELECT pg_backend_pid() AS id" : "SELECT CONNECTION_ID() AS id");
  assert.equal(ids.length, 2);
  assert.ok(!ids.includes(other[0].id));
  await second.close();
  const cpuBefore = process.cpuUsage();
  await Bun.sleep(2200);
  const cpuIdleClose = process.cpuUsage(cpuBefore);
  const afterClose = process.cpuUsage();
  await Bun.sleep(2200);
  emit("pool", { statements: [statement], ids, otherId: other[0].id, events, cpuIdleCloseUs: cpuIdleClose, cpuAfterIdleCloseUs: process.cpuUsage(afterClose), options: { max: 2, idleTimeout: 1, maxLifetime: 0 } });
  assert.equal(events.filter(event => event.event === "close").length, 2);
  const revived = await sql.unsafe("SELECT 1 AS alive");
  assert.equal(revived[0].alive, 1);
  await sql.close();
}
