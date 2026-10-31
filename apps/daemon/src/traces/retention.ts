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

/** Error Spans and explicitly linked Traces are a soft-budget exception; attribution alone does not pin. */
export const pruneCheckout = (
  db: Database,
  checkout: string,
  retention: Retention,
  now: number
): boolean => {
  const cutoff = now - retention.maxAgeMs;
  const changed = new Set<string>();
  let bytes = checkoutBytes(db, checkout);
  let removed = false;

  while (true) {
    const pressure = bytes > retention.maxBytes;

    const rows = decodeCandidates(
      db
        .query(`SELECT id,trace_id,bytes,kind FROM (
      SELECT s.id,s.trace_id,s.bytes,s.age,'span' AS kind FROM spans s WHERE s.checkout=? AND ${droppableSpan} AND (? OR s.age<?)
      UNION ALL
      SELECT s.id,s.trace_id,s.bytes,s.age,'log' AS kind FROM logs s WHERE s.checkout=? AND ${droppableLog} AND (? OR s.age<?)
    ) ORDER BY age,id LIMIT 512`)
        .all(checkout, Number(pressure), cutoff, checkout, Number(pressure), cutoff)
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      removeCandidate(db, checkout, row);

      if (row.kind === "span" && row.trace_id !== null) changed.add(row.trace_id);
      bytes -= row.bytes;
      removed = true;

      // Once pressure is relieved, a new query selects only records beyond the age limit.
      if (pressure && bytes <= retention.maxBytes) break;
    }
  }

  for (const id of changed) refreshSummary(db, checkout, id, true);

  return removed;
};
