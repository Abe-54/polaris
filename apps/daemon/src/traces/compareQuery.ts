import type { Database, SQLQueryBindings } from "bun:sqlite";
import { Schema } from "effect";
import {
  TraceCompareSelector,
  TraceComparison,
  TraceError,
  type TraceRouteStats,
} from "@polaris/protocol";
import { sortableTime, decodeValueRows } from "./database.ts";
import { notFound } from "./queries.ts";
import { compareInputError } from "./compare.ts";

const summaryRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      service: Schema.String,
      route: Schema.String,
      duration: Schema.Number,
      partial: Schema.Number,
    })
  )
);

const newRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      routeService: Schema.String,
      route: Schema.String,
      name: Schema.String,
      service: Schema.String,
      durationMs: Schema.Number,
      traceId: Schema.String,
      spanId: Schema.String,
    })
  )
);

const selection = (db: Database, checkout: string, selector: TraceCompareSelector) => {
  if (TraceCompareSelector.guards.Turn(selector))
    return { sql: "checkout=? AND turn_id=?", bindings: [checkout, selector.turnId] };

  if (!TraceCompareSelector.guards.Trace(selector)) throw compareInputError();

  const rows = decodeValueRows(
    db
      .query("SELECT trace_id AS value FROM summaries WHERE checkout=? AND trace_id LIKE ? LIMIT 2")
      .all(checkout, `${selector.traceId}%`)
  );

  if (rows.length === 0) throw notFound();

  if (rows.length > 1)
    throw new TraceError({
      code: "E-TRACE-AMBIGUOUS",
      message: "The trace id prefix matches more than one trace.",
      fix: "Use a longer prefix or the full trace id.",
    });

  return { sql: "checkout=? AND trace_id=?", bindings: [checkout, rows[0]!.value] };
};

const stats = (values: number[], enough: boolean): TraceRouteStats => {
  values.sort((a, b) => a - b);

  return {
    count: values.length,
    p50Ms: enough ? values[Math.ceil(values.length * 0.5) - 1]! : null,
    p95Ms: enough ? values[Math.ceil(values.length * 0.95) - 1]! : null,
  };
};

const key = (service: string, route: string) => JSON.stringify([service, route]);

/** One worker snapshot, projected summary rows and one batched semantic Span difference. */
export const compareTraces = (
  db: Database,
  checkout: string,
  a: TraceCompareSelector,
  b: TraceCompareSelector,
  baselineStart?: string
): TraceComparison => {
  const after = selection(db, checkout, b);
  const baseline = TraceCompareSelector.guards.Baseline(a);

  if (baseline && (!TraceCompareSelector.guards.Turn(b) || baselineStart === undefined))
    throw compareInputError();

  const before = baseline
    ? {
        sql: `checkout=? AND start<? AND turn_id IS NOT NULL AND turn_id<>?
      AND EXISTS (SELECT 1 FROM b WHERE b.root=summaries.root
        AND b.routeService=json_extract(summaries.value,'$.service'))`,
        bindings: [
          checkout,
          sortableTime(baselineStart!),
          TraceCompareSelector.guards.Turn(b) ? b.turnId : "",
        ],
      }
    : selection(db, checkout, a);

  const columns =
    "checkout,trace_id,root,duration,partial,json_extract(value,'$.service') AS routeService";

  const cte = `WITH b AS MATERIALIZED (SELECT ${columns} FROM summaries WHERE ${after.sql}),
    a AS MATERIALIZED (SELECT ${columns} FROM summaries WHERE ${before.sql})`;

  const bindings: SQLQueryBindings[] = [...after.bindings, ...before.bindings];

  const read = (side: "a" | "b") =>
    summaryRows(
      db
        .query(`${cte}
    SELECT routeService AS service,root AS route,duration,partial FROM ${side}`)
        .all(...bindings)
    );

  const groups = new Map<
    string,
    {
      service: string;
      route: string;
      before: number[];
      after: number[];
      partial: { before: number; after: number };
    }
  >();

  for (const [side, rows] of [
    ["before", read("a")],
    ["after", read("b")],
  ] as const) {
    for (const row of rows) {
      const id = key(row.service, row.route);
      let group = groups.get(id);

      if (group === undefined) {
        group = {
          service: row.service,
          route: row.route,
          before: [],
          after: [],
          partial: { before: 0, after: 0 },
        };
        groups.set(id, group);
      }

      if (row.partial) group.partial[side]++;
      else group[side].push(row.duration);
    }
  }

  const spans = (side: "a" | "b") => `SELECT s.routeService,
    s.root AS route,p.service,json_extract(p.value,'$.name') AS name,
    json_extract(parent.value,'$.name') AS parentName,
    json_extract(p.value,'$.durationMs') AS durationMs,p.trace_id AS traceId,p.id AS spanId
    FROM ${side} s JOIN spans p ON p.checkout=s.checkout AND p.trace_id=s.trace_id
    LEFT JOIN spans parent ON parent.checkout=p.checkout AND parent.trace_id=p.trace_id AND parent.id=p.parent
    WHERE s.partial=0`;

  const newest = newRows(
    db
      .query(`${cte},
    old AS MATERIALIZED (SELECT DISTINCT routeService,route,service,name,parentName FROM (${spans("a")})),
    ranked AS (SELECT n.*,row_number() OVER (
      PARTITION BY routeService,route ORDER BY durationMs DESC,traceId,spanId) AS rank
      FROM (${spans("b")}) n WHERE NOT EXISTS (SELECT 1 FROM old o
        WHERE o.routeService=n.routeService AND o.route=n.route AND o.service=n.service
          AND o.name=n.name AND o.parentName IS n.parentName))
    SELECT routeService,route,name,service,durationMs,traceId,spanId FROM ranked WHERE rank=1`)
      .all(...bindings)
  );

  const newByRoute = new Map(
    newest.map(({ routeService, route, ...span }) => [key(routeService, route), span])
  );

  return TraceComparison.make({
    a,
    b,
    routes: [...groups.values()]
      .sort((x, y) =>
        x.service < y.service
          ? -1
          : x.service > y.service
            ? 1
            : x.route < y.route
              ? -1
              : x.route > y.route
                ? 1
                : 0
      )
      .map((group) => {
        const enough = group.before.length >= 3 && group.after.length >= 3;
        const slowestNew = newByRoute.get(key(group.service, group.route));

        return {
          service: group.service,
          route: group.route,
          before: stats(group.before, enough),
          after: stats(group.after, enough),
          ...(slowestNew === undefined ? undefined : { slowestNew }),
          ...(group.partial.before + group.partial.after === 0
            ? undefined
            : { partial: group.partial }),
        };
      }),
  });
};
