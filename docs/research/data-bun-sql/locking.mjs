import assert from "node:assert/strict";
import { connect, emit, engine, observe, single } from "./report.mjs";

export async function locking() {
  if (engine !== "mysql") return;
  const reader = connect();
  const writer = connect();
  await writer.unsafe("SET SESSION innodb_lock_wait_timeout=1");
  for (const clause of ["LOCK IN SHARE MODE", "FOR SHARE"]) {
    const statement = `SELECT * FROM probe ${clause}`;
    const start = performance.now();
    await reader.begin("read only", async tx => {
      await single(tx, statement);
      await observe("mysql-share-lock-held", [statement, "concurrent UPDATE probe SET v=v+1 WHERE id=1"], () => single(writer, "UPDATE probe SET v=v+1 WHERE id=1"));
    });
    const heldMs = performance.now() - start;
    const after = performance.now();
    const rows = await single(writer, "UPDATE probe SET v=v+1 WHERE id=1");
    emit("mysql-share-lock-released", { statement, heldMs, afterCommitMs: performance.now() - after, affectedRows: rows.affectedRows });
    assert.equal(rows.affectedRows, 1);
    const slowStatement = `SELECT id,SLEEP(0.6) AS slept FROM probe ${clause}`;
    const slowStart = performance.now();
    let competing;
    let writerStart;
    await reader.begin("read only", async tx => {
      const pending = single(tx, slowStatement).execute();
      await Bun.sleep(100);
      writerStart = performance.now();
      competing = single(writer, "UPDATE probe SET v=v+1 WHERE id=1").then(result => ({ affectedRows: result.affectedRows, completedAtMs: performance.now() - slowStart }));
      await pending;
    });
    const readerReturnedMs = performance.now() - slowStart;
    const result = await competing;
    emit("mysql-share-lock-slow-query", { statement: slowStatement, readerReturnedMs, writerWaitMs: result.completedAtMs - (writerStart - slowStart), ...result });
    assert.equal(result.affectedRows, 1);
  }
  await reader.close();
  await writer.unsafe("UPDATE probe SET v=0");
  await writer.close();
}
