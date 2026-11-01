import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { refreshSummary, type Retention } from "./database.ts";

const Bytes = Schema.Struct({ bytes: Schema.Number });

const decodeBytes = Schema.decodeUnknownSync(Bytes);

const decodeCandidates = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      trace_id: Schema.NullOr(Schema.String),
      bytes: Schema.Number,
      kind: Schema.Literals(["span", "log"]),
    })
  )
);

const unpinned =
  "NOT EXISTS (SELECT 1 FROM trace_pins p WHERE p.checkout=s.checkout AND p.trace_id=s.trace_id)";

const droppableSpan = `s.status<>'error' AND ${unpinned}`;

const droppableLog = `s.severity<17 AND ${unpinned}
  AND NOT EXISTS (SELECT 1 FROM spans x WHERE x.checkout=s.checkout AND x.trace_id=s.trace_id AND x.id=s.span_id AND x.status='error')`;

export const checkoutBytes = (db: Database, checkout: string): number =>
  decodeBytes(
    db
      .query(`SELECT coalesce(sum(bytes),0) AS bytes FROM (
    SELECT bytes FROM spans WHERE checkout=? UNION ALL SELECT bytes FROM logs WHERE checkout=?)`)
      .get(checkout, checkout)
  ).bytes;

const removeCandidate = (
  db: Database,
  checkout: string,
  row: ReturnType<typeof decodeCandidates>[number]
): void => {
  if (row.kind === "span")
    db.query("DELETE FROM spans WHERE checkout=? AND trace_id=? AND id=?").run(
      checkout,
      row.trace_id,
      row.id
    );
  else db.query("DELETE FROM logs WHERE checkout=? AND id=?").run(checkout, row.id);
};

interface PruneState {
  bytes: number;
  removed: boolean;
  readonly changed: Set<string>;
}

const candidates = (
  db: Database,
  checkout: string,
  cutoff: number,
  policy: { span: string; log: string },
  pressure: boolean
) => {
  const age = pressure ? "" : " AND s.age<?";
  const bindings = pressure ? [checkout, checkout] : [checkout, cutoff, checkout, cutoff];

  return decodeCandidates(
    db
      .query(`SELECT id,trace_id,bytes,kind FROM (
    SELECT s.id,s.trace_id,s.bytes,s.age,'span' AS kind FROM spans s WHERE s.checkout=? AND ${policy.span}${age}
    UNION ALL
    SELECT s.id,s.trace_id,s.bytes,s.age,'log' AS kind FROM logs s WHERE s.checkout=? AND ${policy.log}${age}
  ) ORDER BY age,id LIMIT 512`)
      .all(...bindings)
  );
};

const pruneRecords = (
  db: Database,
  checkout: string,
  cutoff: number,
  policy: { span: string; log: string; budget: number },
  state: PruneState
) => {
  while (true) {
    const pressure = state.bytes > policy.budget;
    const rows = candidates(db, checkout, cutoff, policy, pressure);

    if (rows.length === 0) return;

    for (const row of rows) {
      removeCandidate(db, checkout, row);

      if (row.kind === "span" && row.trace_id !== null) state.changed.add(row.trace_id);
      state.bytes -= row.bytes;
      state.removed = true;

      if (pressure && state.bytes <= policy.budget) return;
    }
  }
};

/** Pinned Traces survive; errors get a bounded pressure allowance, never an age exemption. */
export const pruneCheckout = (
  db: Database,
  checkout: string,
  retention: Retention,
  now: number
): boolean => {
  const cutoff = now - retention.maxAgeMs;

  const state: PruneState = {
    bytes: checkoutBytes(db, checkout),
    removed: false,
    changed: new Set(),
  };

  pruneRecords(db, checkout, cutoff, { span: unpinned, log: unpinned, budget: Infinity }, state);

  for (const policy of [
    { span: droppableSpan, log: droppableLog, budget: retention.maxBytes },
    { span: unpinned, log: unpinned, budget: retention.maxBytes * 2 },
  ]) {
    if (state.bytes > policy.budget) pruneRecords(db, checkout, cutoff, policy, state);
  }

  for (const id of state.changed) refreshSummary(db, checkout, id, true);

  return state.removed;
};
