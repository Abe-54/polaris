import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { compareYield } from "./compareYield.ts";

const decodeTraces = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      traceId: Schema.String,
      service: Schema.String,
      route: Schema.String,
    })
  )
);

const decodeSpans = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      parentName: Schema.NullOr(Schema.String),
      service: Schema.String,
      durationMs: Schema.Number,
      traceId: Schema.String,
      spanId: Schema.String,
    })
  )
);

const decodeIds = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      traceId: Schema.String,
      spanId: Schema.String,
    })
  )
);

type Candidate = ReturnType<typeof decodeSpans>[number];

const earlier = (span: Candidate, previous: Candidate) =>
  span.durationMs > previous.durationMs ||
  (span.durationMs === previous.durationMs &&
    (span.traceId < previous.traceId ||
      (span.traceId === previous.traceId && span.spanId < previous.spanId)));

const hasSignature = async (
  db: Database,
  checkout: string,
  span: Candidate,
  before: Set<string>
) => {
  if (before.size === 0) return false;

  const query =
    db.query(`SELECT trace_id AS traceId,id AS spanId FROM spans INDEXED BY spans_compare
    WHERE checkout=? AND name=? AND parent_name IS ? AND service=? AND (trace_id,id)>(?,?)
    ORDER BY trace_id,id LIMIT 32`);

  let trace = "";
  let id = "";

  while (true) {
    const rows = decodeIds(
      query.all(checkout, span.name, span.parentName, span.service, trace, id)
    );

    if (rows.some((row) => before.has(row.traceId))) return true;

    if (rows.length < 32) return false;

    const last = rows[rows.length - 1]!;
    trace = last.traceId;
    id = last.spanId;
    await compareYield();
  }
};

const traces = async function* (db: Database, side: "a" | "b") {
  const query = db.query(`SELECT trace_id AS traceId,routeService AS service,root AS route
    FROM compare_${side} WHERE partial=0 AND trace_id>? ORDER BY trace_id LIMIT 32`);

  let cursor = "";
  let rows = decodeTraces(query.all(cursor));

  while (rows.length > 0) {
    yield rows;
    cursor = rows[rows.length - 1]!.traceId;
    await compareYield();
    rows = decodeTraces(query.all(cursor));
  }
};

const beforeTraces = async (db: Database) => {
  const before = new Map<string, Set<string>>();

  for await (const rows of traces(db, "a")) {
    for (const trace of rows) {
      const key = JSON.stringify([trace.service, trace.route]);
      let ids = before.get(key);

      if (ids === undefined) {
        ids = new Set();
        before.set(key, ids);
      }

      ids.add(trace.traceId);
    }
  }

  return before;
};

const spanPages = async function* (db: Database, checkout: string, traceId: string) {
  const query = db.query(`SELECT name,parent_name AS parentName,service,duration AS durationMs,
    trace_id AS traceId,id AS spanId FROM spans WHERE checkout=? AND trace_id=? AND id>?
    ORDER BY id LIMIT 32`);

  let cursor = "";
  let rows = decodeSpans(query.all(checkout, traceId, cursor));

  while (rows.length > 0) {
    yield rows;
    cursor = rows[rows.length - 1]!.spanId;
    await compareYield();
    rows = decodeSpans(query.all(checkout, traceId, cursor));
  }
};

const winner = async (
  db: Database,
  checkout: string,
  trace: ReturnType<typeof decodeTraces>[number],
  before: Set<string>,
  seen: Map<string, boolean>,
  previous: Candidate | undefined
) => {
  let result = previous;
  const routeKey = JSON.stringify([trace.service, trace.route]);

  for await (const spans of spanPages(db, checkout, trace.traceId)) {
    for (const span of spans) {
      if (result !== undefined && !earlier(span, result)) continue;

      const signature = JSON.stringify([routeKey, span.service, span.name, span.parentName]);
      let exists = seen.get(signature);

      if (exists === undefined) {
        exists = await hasSignature(db, checkout, span, before);
        seen.set(signature, exists);
      }

      if (!exists) result = span;
    }
  }

  return result;
};

/** Probe indexed semantic signatures in chunks, preserving a stable duration/id winner. */
export const newSpans = async (db: Database, checkout: string) => {
  const before = await beforeTraces(db);
  const result = new Map<string, Candidate>();
  const seen = new Map<string, boolean>();

  for await (const rows of traces(db, "b")) {
    for (const trace of rows) {
      const key = JSON.stringify([trace.service, trace.route]);

      const span = await winner(
        db,
        checkout,
        trace,
        before.get(key) ?? new Set(),
        seen,
        result.get(key)
      );

      if (span !== undefined) result.set(key, span);
    }
  }

  return new Map(
    [...result].map(([key, span]) => [
      key,
      {
        name: span.name,
        service: span.service,
        durationMs: span.durationMs,
        traceId: span.traceId,
        spanId: span.spanId,
      },
    ])
  );
};
