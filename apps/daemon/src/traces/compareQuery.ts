import { Database } from "bun:sqlite";
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
import { newSpans } from "./compareSpans.ts";
import { compareYield } from "./compareYield.ts";

const summaryRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      service: Schema.String,
      route: Schema.String,
      duration: Schema.Number,
      partial: Schema.Number,
      traceId: Schema.String,
    })
  )
);

/** The Turn ids a Turn or Turns selector resolved to in its Agent Session, in order. */
export interface CompareTurns {
  readonly baselineStart?: string;
  readonly a?: ReadonlyArray<string>;
  readonly b?: ReadonlyArray<string>;
}

const turnsOf = (selector: TraceCompareSelector, resolved: ReadonlyArray<string> | undefined) => {
  if (resolved !== undefined && resolved.length > 0) return resolved;

  if (TraceCompareSelector.guards.Turn(selector)) return [selector.turnId];

  throw compareInputError();
};

const inList = (ids: ReadonlyArray<string>) => ids.map(() => "?").join(",");

const selection = (
  db: Database,
  checkout: string,
  selector: TraceCompareSelector,
  resolved: ReadonlyArray<string> | undefined
) => {
  if (TraceCompareSelector.guards.Turn(selector) || TraceCompareSelector.guards.Turns(selector)) {
    const ids = turnsOf(selector, resolved);

    return {
      sql: `s.checkout=? AND s.turn_id IN (${inList(ids)})`,
      bindings: [checkout, ...ids],
      index: ids.length === 1 ? "summaries_turn" : "sqlite_autoindex_summaries_1",
    };
  }

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

  return {
    sql: "s.checkout=? AND s.trace_id=?",
    bindings: [checkout, rows[0]!.value],
    index: "sqlite_autoindex_summaries_1",
  };
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

interface Group {
  service: string;
  route: string;
  before: number[];
  after: number[];
  partial: { before: number; after: number };
}

const groupsFor = async (
  read: (side: "a" | "b", cursor: string) => ReturnType<typeof summaryRows>
) => {
  const groups = new Map<string, Group>();

  for (const [side, table] of [
    ["before", "a"],
    ["after", "b"],
  ] as const) {
    let cursor = "";
    let rows = read(table, cursor);

    while (rows.length > 0) {
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

      cursor = rows[rows.length - 1]!.traceId;
      await compareYield();
      rows = read(table, cursor);
    }
  }

  return groups;
};

/** Materialize each side once; probe only the after side's semantic Span signatures. */
const compareSnapshot = async (
  db: Database,
  checkout: string,
  a: TraceCompareSelector,
  b: TraceCompareSelector,
  turns: CompareTurns = {}
): Promise<TraceComparison> => {
  const { baselineStart } = turns;
  const after = selection(db, checkout, b, turns.b);
  const baseline = TraceCompareSelector.guards.Baseline(a);
  const target = after.bindings.slice(1);

  if (baseline && (TraceCompareSelector.guards.Trace(b) || baselineStart === undefined))
    throw compareInputError();

  const before = baseline
    ? {
        sql: `s.checkout=? AND r.start<? AND s.turn_id IS NOT NULL AND s.turn_id NOT IN (${inList(target)})
      AND s.root IN (SELECT root FROM compare_b)
      AND EXISTS (SELECT 1 FROM compare_b b WHERE b.root=s.root
        AND b.routeService=json_extract(s.value,'$.service'))`,
        bindings: [checkout, sortableTime(baselineStart!), ...target],
        index: "sqlite_autoindex_summaries_1",
      }
    : selection(db, checkout, a, turns.a);

  const columns = `s.checkout,s.trace_id,s.root,s.duration,
    (s.partial OR NOT (r.parent IS NULL OR (json_extract(r.value,'$.kind') IN ('server','consumer')
      AND NOT EXISTS (SELECT 1 FROM spans p WHERE p.checkout=r.checkout
        AND p.trace_id=r.trace_id AND p.id=r.parent)))) AS partial,
    json_extract(s.value,'$.service') AS routeService`;

  const materialize = async (side: "a" | "b", selected: ReturnType<typeof selection>) => {
    db.exec(`CREATE TEMP TABLE compare_${side} AS SELECT ${columns} FROM summaries s INDEXED BY sqlite_autoindex_summaries_1
      JOIN spans r ON r.checkout=s.checkout AND r.trace_id=s.trace_id
        AND r.id=json_extract(s.value,'$.rootSpanId') WHERE 0;
      CREATE INDEX compare_${side}_trace ON compare_${side}(trace_id);
      CREATE INDEX compare_${side}_route ON compare_${side}(root,routeService)`);

    if (baseline && side === "a" && db.query("SELECT 1 FROM compare_b LIMIT 1").get() === null)
      return;

    const scan =
      baseline && side === "a" ? { sql: "s.checkout=?", bindings: [checkout] } : selected;

    const page = `SELECT * FROM summaries s INDEXED BY ${selected.index}
      WHERE ${scan.sql} AND s.trace_id>? ORDER BY s.trace_id LIMIT 32`;

    const next = db.query(`SELECT trace_id AS value FROM (${page})`);

    const insert = db.query(`WITH page AS MATERIALIZED (${page})
      INSERT INTO compare_${side} SELECT ${columns} FROM page s
      JOIN spans r ON r.checkout=s.checkout AND r.trace_id=s.trace_id
        AND r.id=json_extract(s.value,'$.rootSpanId') WHERE ${selected.sql}`);

    let cursor = "";
    let ids = decodeValueRows(next.all(...scan.bindings, cursor));

    while (ids.length > 0) {
      insert.run(...scan.bindings, cursor, ...selected.bindings);
      cursor = ids[ids.length - 1]!.value;
      await compareYield();
      ids = decodeValueRows(next.all(...scan.bindings, cursor));
    }
  };

  await materialize("b", after);
  await compareYield(true);
  await materialize("a", before);

  const read = (side: "a" | "b", cursor: string) =>
    summaryRows(
      db
        .query(
          `SELECT trace_id AS traceId,routeService AS service,root AS route,duration,partial
      FROM compare_${side} WHERE trace_id>? ORDER BY trace_id LIMIT 32`
        )
        .all(cursor)
    );

  const groups = await groupsFor(read);

  const newByRoute = await newSpans(db, checkout);

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

/** A read snapshot in WAL lets ingest and other trace reads run between bounded chunks. */
export const compareTraces = async (
  db: Database,
  checkout: string,
  a: TraceCompareSelector,
  b: TraceCompareSelector,
  turns: CompareTurns = {}
): Promise<TraceComparison> => {
  const memory = db.filename === ":memory:";
  const snapshot = memory ? db : new Database(db.filename, { readonly: true });

  try {
    snapshot.exec("BEGIN");

    return await compareSnapshot(snapshot, checkout, a, b, turns);
  } finally {
    try {
      if (snapshot.inTransaction) snapshot.exec("ROLLBACK");
    } finally {
      if (!memory) snapshot.close();
    }
  }
};
