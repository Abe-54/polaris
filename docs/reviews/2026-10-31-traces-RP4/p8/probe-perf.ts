import { openTraceDatabase, sortableTime } from "../../../../apps/daemon/src/traces/database.ts";
import { compareTraces } from "../../../../apps/daemon/src/traces/compareQuery.ts";
import { TraceCompareSelector, TurnId } from "../../../../packages/protocol/src/index.ts";

const TRACES = Number(process.argv[2] ?? 3000);
const SPANS = Number(process.argv[3] ?? 60);
const db = openTraceDatabase(process.argv[4] ?? ":memory:");
const checkout = "/tmp/p8-perf";
const pad = "x".repeat(700);
const base = 1_800_000_000_000_000_000n;
const insertSpan = db.query(`INSERT INTO spans (checkout,trace_id,id,parent,start,end,service,status,age,bytes,value,name,duration,parent_name,trace_start) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insertSummary = db.query(`INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?)`);
let t0 = performance.now();
const fill = (turn: string, count: number, offset: bigint, first: number) => db.transaction(() => {
  for (let t = 0; t < count; t++) {
    const traceId = (first + t).toString(16).padStart(32, "0");
    const start = base + offset + BigInt(t) * 1_000_000n;
    for (let s = 0; s < SPANS; s++) {
      const id = (s + 1).toString(16).padStart(16, "0");
      const name = s === 0 ? "POST /invoices" : `db.query ${s % 12}`;
      const parent = s === 0 ? null : (1).toString(16).padStart(16, "0");
      const value = JSON.stringify({ name, durationMs: 5 + s, service: "ledger-api", attributes: { pad } });
      insertSpan.run(checkout, traceId, id, parent, sortableTime(start.toString()), sortableTime((start + 5_000_000n).toString()), "ledger-api", "ok", Number(start / 1_000_000n), value.length + 256, value, name, 5 + s, s === 0 ? null : "POST /invoices", sortableTime(start.toString()));
    }
    insertSummary.run(checkout, traceId, sortableTime(start.toString()), "POST /invoices", 100 + (t % 50), 0, turn, 0, JSON.stringify({ service: "ledger-api", id: traceId }));
  }
})();
fill("turn-early", TRACES, 0n, 1);
const targetStart = base + 10_000_000_000_000n;
fill("turn-target", 30, 10_000_000_000_001n, 10_000_000);
console.log(`filled ${TRACES * SPANS + 30 * SPANS} spans in ${(performance.now() - t0).toFixed(0)} ms`);
const baseline = TraceCompareSelector.cases.Baseline.make({});
const target = TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("turn-target") });
for (let i = 0; i < 3; i++) {
  t0 = performance.now();
  const result = compareTraces(db, checkout, baseline, target, { b: ["turn-target"], baselineStart: targetStart.toString() });
  console.log(`baseline compare ${(performance.now() - t0).toFixed(0)} ms`, JSON.stringify(result.routes[0]?.before), JSON.stringify(result.routes[0]?.slowestNew ?? null));
}
console.log(db.query("EXPLAIN QUERY PLAN SELECT trace_id FROM summaries WHERE checkout=? AND turn_id IN (?)").all(checkout, "turn-target"));

// Phase split: the before-side signature scan alone, as compareQuery writes it and from the indexed columns.
const time = (label: string, sql: string, ...args: (string | number)[]) => {
  const t = performance.now();
  const rows = db.query(sql).all(...args);
  console.log(label, `${(performance.now() - t).toFixed(0)} ms`, rows.length);
};
time("old signatures via json_extract + parent self-join", `SELECT DISTINCT p.service,json_extract(p.value,'$.name'),json_extract(parent.value,'$.name') FROM summaries s JOIN spans p ON p.checkout=s.checkout AND p.trace_id=s.trace_id LEFT JOIN spans parent ON parent.checkout=p.checkout AND parent.trace_id=p.trace_id AND parent.id=p.parent WHERE s.checkout=? AND s.turn_id='turn-early'`, checkout);
time("old signatures via name/parent_name columns", `SELECT DISTINCT p.service,p.name,p.parent_name FROM summaries s JOIN spans p ON p.checkout=s.checkout AND p.trace_id=s.trace_id WHERE s.checkout=? AND s.turn_id='turn-early'`, checkout);
