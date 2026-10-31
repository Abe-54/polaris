import type { Database, SQLQueryBindings } from "bun:sqlite";
import { Schema } from "effect";
import {
  LogRecord,
  Span,
  TraceError,
  TraceSummary,
  type TraceDetail,
  type TraceFilter,
  type SpanDetail,
} from "@polaris/protocol";
import { decodeValueRows, refreshSummary } from "./database.ts";

const decodeSummary = Schema.decodeUnknownSync(Schema.fromJsonString(TraceSummary));

const decodeSpan = Schema.decodeUnknownSync(Schema.fromJsonString(Span));

const decodeLog = Schema.decodeUnknownSync(Schema.fromJsonString(LogRecord));

const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }));

export const notFound = () =>
  new TraceError({
    code: "E-TRACE-NOT-FOUND",
    message: "No matching trace or span in this checkout.",
    fix: "List this checkout's traces again; it may have expired or been sampled out.",
  });

const ambiguous = () =>
  new TraceError({
    code: "E-TRACE-AMBIGUOUS",
    message: "The id prefix matches more than one trace or span.",
    fix: "Use a longer prefix or the full id.",
  });

const one = <A>(rows: ReadonlyArray<A>): A => {
  if (rows.length === 0) throw notFound();

  if (rows.length > 1) throw ambiguous();

  return rows[0]!;
};

const globLike = (glob: string): string =>
  glob.replace(/[\\%_*?]/g, (char) => {
    if (char === "*") return "%";

    if (char === "?") return "_";

    return `\\${char}`;
  });

const where = (checkout: string, filter: TraceFilter) => {
  const clauses = ["s.checkout=?"];
  const bindings: SQLQueryBindings[] = [checkout];

  const add = (sql: string, value: SQLQueryBindings) => {
    clauses.push(sql);
    bindings.push(value);
  };

  if (filter.turn !== undefined) add("s.turn_id IS ?", filter.turn);

  if (filter.route !== undefined) add("s.root LIKE ? ESCAPE '\\'", globLike(filter.route));

  if (filter.service !== undefined)
    add(
      "EXISTS (SELECT 1 FROM spans p WHERE p.checkout=s.checkout AND p.trace_id=s.trace_id AND p.service=?)",
      filter.service
    );

  if (filter.minMs !== undefined) add("s.duration>=?", filter.minMs);

  if (filter.status !== undefined)
    clauses.push(filter.status === "error" ? "s.errors>0" : "s.errors=0");

  return { sql: clauses.join(" AND "), bindings };
};

export const listTraces = (db: Database, checkout: string, filter: TraceFilter = {}) => {
  const query = where(checkout, filter);

  const total = decodeCount(
    db.query(`SELECT count(*) AS count FROM summaries s WHERE ${query.sql}`).get(...query.bindings)
  ).count;

  const traces = decodeValueRows(
    db
      .query(
        `SELECT value FROM summaries s WHERE ${query.sql} ORDER BY start DESC,trace_id LIMIT ?`
      )
      .all(...query.bindings, filter.limit ?? 50)
  ).map((row) => decodeSummary(row.value));

  return { traces, total };
};

const summaryFor = (db: Database, checkout: string, prefix: string) =>
  decodeSummary(
    one(
      decodeValueRows(
        db
          .query("SELECT value FROM summaries WHERE checkout=? AND trace_id LIKE ? LIMIT 2")
          .all(checkout, `${prefix}%`)
      )
    ).value
  );

export const getTrace = (db: Database, checkout: string, prefix: string): TraceDetail => {
  const summary = summaryFor(db, checkout, prefix);

  const spans = decodeValueRows(
    db
      .query("SELECT value FROM spans WHERE checkout=? AND trace_id=? ORDER BY start,id")
      .all(checkout, summary.id)
  ).map((row) => decodeSpan(row.value));

  return { summary, spans };
};

export const getSpan = (
  db: Database,
  checkout: string,
  tracePrefix: string,
  spanPrefix: string
): SpanDetail => {
  const summary = summaryFor(db, checkout, tracePrefix);

  const span = decodeSpan(
    one(
      decodeValueRows(
        db
          .query("SELECT value FROM spans WHERE checkout=? AND trace_id=? AND id LIKE ? LIMIT 2")
          .all(checkout, summary.id, `${spanPrefix}%`)
      )
    ).value
  );

  const params = [checkout, summary.id, span.id];

  const logs = decodeValueRows(
    db
      .query(
        "SELECT value FROM logs WHERE checkout=? AND trace_id=? AND span_id=? ORDER BY time DESC,id LIMIT 20"
      )
      .all(...params)
  ).map((row) => decodeLog(row.value));

  const logCount = decodeCount(
    db
      .query("SELECT count(*) AS count FROM logs WHERE checkout=? AND trace_id=? AND span_id=?")
      .get(...params)
  ).count;

  return { span, logs, logCount };
};

/** Internal retention link for consumers; RPC reads never pin by accident. */
export const linkTrace = (db: Database, checkout: string, prefix: string): void => {
  const summary = summaryFor(db, checkout, prefix);
  db.query("INSERT OR IGNORE INTO trace_pins VALUES (?,?)").run(checkout, summary.id);
  refreshSummary(db, checkout, summary.id);
};

/** Medians use earlier retained traces only; five observations are required for a baseline. */
export const traceHistory = (
  db: Database,
  checkout: string,
  traceId: string,
  includeSpans = true
) => {
  const summary = summaryFor(db, checkout, traceId);
  const before = summary.startTimeUnixNano.padStart(20, "0");

  const rootRows = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ usual: Schema.NullOr(Schema.Number) }))
  )(
    db
      .query(`
    WITH samples AS (
      SELECT duration,row_number() OVER (ORDER BY duration) AS position,count(*) OVER () AS count
      FROM summaries WHERE checkout=? AND root=? AND start<? AND trace_id<>?
    ) SELECT avg(duration) AS usual FROM samples WHERE count>=5 AND position IN ((count+1)/2,(count+2)/2)
  `)
      .all(checkout, summary.root, before, summary.id)
  );

  const spans: Record<string, number> = {};
  const samples: Record<string, number> = {};
  const root = rootRows[0]?.usual ?? null;

  if (!includeSpans) return { root, spans, samples };
  const trace = getTrace(db, checkout, summary.id);

  const medians = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        parent: Schema.NullOr(Schema.String),
        usual: Schema.Number,
        samples: Schema.Number,
      })
    )
  )(
    db
      .query(`
    WITH wanted AS (
      SELECT DISTINCT json_extract(c.value,'$.name') AS name,
        json_extract(p.value,'$.name') AS parent
      FROM spans c LEFT JOIN spans p
        ON p.checkout=c.checkout AND p.trace_id=c.trace_id AND p.id=c.parent
      WHERE c.checkout=? AND c.trace_id=?
    ), samples AS (
      SELECT w.name,w.parent,json_extract(c.value,'$.durationMs') AS ms
      FROM wanted w JOIN spans c ON c.checkout=? AND json_extract(c.value,'$.name')=w.name
      JOIN summaries s ON s.checkout=c.checkout AND s.trace_id=c.trace_id
      LEFT JOIN spans p ON p.checkout=c.checkout AND p.trace_id=c.trace_id AND p.id=c.parent
      WHERE s.start<? AND s.trace_id<>? AND json_extract(p.value,'$.name') IS w.parent
    ), ranked AS (
      SELECT *,row_number() OVER (PARTITION BY name,parent ORDER BY ms) AS position,
        count(*) OVER (PARTITION BY name,parent) AS count FROM samples
    ) SELECT name,parent,avg(ms) AS usual,max(count) AS samples FROM ranked
      WHERE count>=5 AND position IN ((count+1)/2,(count+2)/2) GROUP BY name,parent
  `)
      .all(checkout, trace.summary.id, checkout, before, trace.summary.id)
  );

  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  const lookup = new Map(medians.map((row) => [JSON.stringify([row.name, row.parent]), row]));

  for (const span of trace.spans) {
    const parent = span.parentId === null ? null : (byId.get(span.parentId)?.name ?? null);
    const usual = lookup.get(JSON.stringify([span.name, parent]));

    if (usual !== undefined) {
      spans[span.id] = usual.usual;
      samples[span.id] = usual.samples;
    }
  }

  return { root, spans, samples };
};
