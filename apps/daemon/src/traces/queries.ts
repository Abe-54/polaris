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

export const summaryFor = (db: Database, checkout: string, prefix: string) =>
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
      FROM (SELECT duration FROM summaries WHERE checkout=? AND root=? AND start<? AND trace_id<>? ORDER BY start DESC LIMIT 50)
    ) SELECT avg(duration) AS usual FROM samples WHERE count>=5 AND position IN ((count+1)/2,(count+2)/2)
  `)
      .all(checkout, summary.root, before, summary.id)
  );

  const spans: Record<string, number> = {};
  const samples: Record<string, number> = {};
  const root = rootRows[0]?.usual ?? null;

  if (!includeSpans) return { root, spans, samples };

  const current = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        parent: Schema.NullOr(Schema.String),
      })
    )
  )(
    db
      .query("SELECT id,name,parent_name AS parent FROM spans WHERE checkout=? AND trace_id=?")
      .all(checkout, summary.id)
  );

  const pairs = [
    ...new Map(
      current.map((span) => [JSON.stringify([span.name, span.parent]), [span.name, span.parent]])
    ).values(),
  ];

  const observations = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        parent: Schema.NullOr(Schema.String),
        durations: Schema.String,
      })
    )
  )(
    db
      .query(`
    WITH wanted AS MATERIALIZED (
      SELECT json_extract(value,'$[0]') AS name,json_extract(value,'$[1]') AS parent FROM json_each(?)
    ), bounded AS MATERIALIZED (
      SELECT w.name,w.parent,(
        SELECT json_group_array(duration) FROM (
          SELECT duration FROM spans c INDEXED BY spans_history_covering
          WHERE c.checkout=? AND c.name=w.name AND c.parent_name IS w.parent AND c.trace_start<?
          ORDER BY c.trace_start DESC,c.start DESC LIMIT 50
        )
      ) AS durations FROM wanted w
    ) SELECT name,parent,durations FROM bounded
  `)
      .all(JSON.stringify(pairs), checkout, before)
  );

  const decodeDurations = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Array(Schema.Number))
  );

  const lookup = new Map<string, { usual: number; samples: number }>();

  for (const row of observations) {
    const values = [...decodeDurations(row.durations)].sort((a, b) => a - b);

    if (values.length < 5) continue;
    const middle = Math.floor(values.length / 2);
    const usual = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
    lookup.set(JSON.stringify([row.name, row.parent]), { usual, samples: values.length });
  }

  for (const span of current) {
    const usual = lookup.get(JSON.stringify([span.name, span.parent]));

    if (usual !== undefined) {
      spans[span.id] = usual.usual;
      samples[span.id] = usual.samples;
    }
  }

  return { root, spans, samples };
};

/** Only one indexed error record per listed trace crosses the SQLite boundary. */
export const listToolTraces = (db: Database, checkout: string, filter: TraceFilter) => {
  const page = listTraces(db, checkout, filter);
  const errors: Record<string, string> = {};
  const history: Record<string, number> = {};

  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        value: Schema.NullOr(Schema.String),
      })
    )
  )(
    db
      .query(`SELECT s.trace_id AS id,(
    SELECT value FROM spans c WHERE c.checkout=s.checkout AND c.trace_id=s.trace_id AND c.status='error'
    ORDER BY c.start,c.id LIMIT 1
  ) AS value FROM summaries s WHERE s.checkout=? AND s.errors>0 AND s.trace_id IN (SELECT value FROM json_each(?))`)
      .all(checkout, JSON.stringify(page.traces.map((trace) => trace.id)))
  );

  for (const row of rows) {
    if (row.value === null) continue;
    const span = decodeSpan(row.value);

    const message = span.events.find((event) => event.name === "exception")?.attributes[
      "exception.message"
    ];

    errors[row.id] =
      message === undefined
        ? span.statusMessage
        : Schema.is(Schema.String)(message)
          ? message
          : JSON.stringify(message);
  }

  for (const trace of page.traces) {
    const { root } = traceHistory(db, checkout, trace.id, false);

    if (root !== null && trace.durationMs > 20 && trace.durationMs > root * 3)
      history[trace.id] = root;
  }

  return { ...page, history, errors };
};
