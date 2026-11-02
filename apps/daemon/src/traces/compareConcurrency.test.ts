import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { openTraceDatabase, sortableTime } from "./database.ts";
import { compareTraces } from "./compareQuery.ts";
import { baseline, turnSelector } from "./compare.testing.ts";

test("compare yields to reads and commits while preserving its original snapshot", async () => {
  const root = newTempDir("compare-concurrency-", { short: true });
  const db = openTraceDatabase(join(root, "traces.sqlite"));
  const start = sortableTime("1800000000000000000");

  const insert = (id: string, turn: string) =>
    db.transaction(() => {
      db.query(`INSERT INTO spans (checkout,trace_id,id,parent,start,end,service,status,age,bytes,value,name,duration)
      VALUES ('checkout',?,'root',NULL,?,?,'api','ok',0,100,?,'route',1)`).run(
        id,
        start,
        start,
        JSON.stringify({ kind: "server" })
      );
      db.query("INSERT INTO summaries VALUES ('checkout',?,?,'route',1,0,?,0,?)").run(
        id,
        start,
        turn,
        JSON.stringify({ service: "api", rootSpanId: "root" })
      );
    })();

  let pending = Promise.resolve();

  try {
    insert("before", "compare-1");
    insert("after", "compare-2");

    let settled = false;

    const competing = new Promise<{ count: number; settled: boolean }>((resolve, reject) =>
      setImmediate(() => {
        try {
          insert("concurrent", "compare-1");
          const rows = db.query("SELECT trace_id FROM summaries WHERE checkout='checkout'").all();

          resolve({ count: rows.length, settled });
        } catch (cause) {
          reject(cause);
        }
      })
    );

    const comparing = compareTraces(db, "checkout", baseline, turnSelector(2), {
      baselineStart: "1800000000000000001",
    }).finally(() => {
      settled = true;
    });

    pending = comparing.then(
      () => undefined,
      () => undefined
    );

    const observed = await competing;
    const result = await comparing;

    expect(observed).toEqual({ count: 3, settled: false });

    expect(result.routes[0]!.before.count).toBe(1);

    const next = await compareTraces(db, "checkout", baseline, turnSelector(2), {
      baselineStart: "1800000000000000001",
    });

    expect(next.routes[0]!.before.count).toBe(2);
  } finally {
    await pending;
    db.close();
    await removeTempDirSettled(root);
  }
});
