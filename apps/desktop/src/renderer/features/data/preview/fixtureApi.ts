/**
 * A `DataApi` over the fixtures, for `<DataLayer api={fixtureDataApi()}>` in previews and tests.
 * Queries read `select … from <table> [where <column> = '<value>']`; writes are refused. A scene
 * can add tables of its own (the bench's 10,000 rows, the worst case's 60 columns).
 */
import { QueryResult, type TableDetail } from "@polaris/protocol";
import { Option } from "effect";
import type { IpcError, Result } from "../../../../shared/api.ts";
import type { DataApi, QueryStream } from "../data/api.ts";
import { cellOf, type DataRow, decodeRows } from "../grid/value.ts";
import {
  FIXTURE_QUERY_LOG,
  FIXTURE_SCHEMA,
  FIXTURE_SOURCES,
  fixtureColumns,
  fixtureRows,
  fixtureTable,
} from "./fixtures.ts";

/** A scene's own table: its detail (columns, keys) and every row. */
export interface FixtureTable {
  readonly detail: TableDetail;
  readonly rows: ReadonlyArray<DataRow>;
}

export type FixtureTables = Readonly<Record<string, FixtureTable>>;

const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  error: { code, message } satisfies IpcError,
});

const DEFAULT_LIMIT = 200;

const STREAM_CAP = 10_000;

/** data.query.stream's chunk: CF's Rows items hold at most 500. */
const CHUNK = 500;

/** The source by name, or why an agent-facing call can't reach it. */
const reach = (name: string): Result<null> => {
  const source = FIXTURE_SOURCES.find((s) => s.name === name);

  if (source === undefined) return fail("E-DATA-UNKNOWN-SOURCE", `No data source named ${name}`);

  if (source.access === "needs-approval" || source.access === "denied")
    return fail("E-DATA-DENIED", `${name} needs a data source approval`);

  return { ok: true, value: null };
};

const FROM = /\bfrom\s+"?(\w+)"?/i;

const WHERE = /\bwhere\s+"?(\w+)"?\s*=\s*'([^']*)'/i;

interface Selected {
  readonly table: string;
  readonly columns: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly rows: ReadonlyArray<DataRow>;
}

const tableOf = (table: string, extra: FixtureTables) => {
  const own = extra[table];

  if (own !== undefined)
    return {
      columns: own.detail.columns.map(({ name, type }) => ({ name, type })),
      rows: own.rows,
    };
  const columns = fixtureColumns(table);
  const rows = Option.getOrNull(decodeRows(fixtureRows(table)));

  return columns === null || rows === null ? null : { columns, rows };
};

/** Every row the SQL selects, before any limit. */
const select = (sql: string, extra: FixtureTables): Result<Selected> => {
  if (!/^\s*(select|with)\b/i.test(sql))
    return fail("E-DATA-READ-ONLY", "Fixture data sources are read-only");
  const table = FROM.exec(sql)?.[1];
  const found = table === undefined ? null : tableOf(table, extra);

  if (table === undefined || found === null)
    return fail("E-DATA-SQL", `relation "${table ?? "?"}" does not exist`);
  const where = WHERE.exec(sql);
  const at = where === null ? -1 : found.columns.findIndex((c) => c.name === where[1]);

  const rows =
    at === -1 ? found.rows : found.rows.filter((row) => cellOf(row[at]).raw === where?.[2]);

  return { ok: true, value: { table, columns: found.columns, rows } };
};

/** Runs the fixture's small SQL subset; exported for the tests. */
export const runFixtureQuery = (
  sql: string,
  limit = DEFAULT_LIMIT,
  extra: FixtureTables = {}
): Result<QueryResult> => {
  const selected = select(sql, extra);

  if (!selected.ok) return selected;
  const { table, columns, rows } = selected.value;

  return {
    ok: true,
    value: new QueryResult({
      queryId: `fixture-${table}`,
      columns,
      rows: rows.slice(0, limit),
      rowCount: Math.min(rows.length, limit),
      returned: Math.min(rows.length, limit),
      total: rows.length,
      truncated: rows.length > limit,
      elapsedMs: 9,
    }),
  };
};

const sampleOf = (table: string, sample: number | undefined) => {
  if (sample === undefined || sample === 0) return undefined;
  const result = runFixtureQuery(`select * from ${table}`, sample);

  return result.ok ? result.value : undefined;
};

/** Header, rows in chunks a tick apart, then the end; cancelling stops the chunks. */
const stream = (selected: Selected, limit: number, on: QueryStream) => {
  const rows = selected.rows.slice(0, Math.min(limit, STREAM_CAP));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sent = 0;

  const step = () => {
    if (sent === 0) on.header({ queryId: `fixture-${selected.table}`, columns: selected.columns });

    if (sent < rows.length) {
      on.rows(rows.slice(sent, sent + CHUNK));
      sent += CHUNK;
      timer = setTimeout(step, 0);

      return;
    }

    on.end({
      returned: rows.length,
      total: selected.rows.length,
      truncated: selected.rows.length > rows.length,
      elapsedMs: 9,
    });
  };

  timer = setTimeout(step, 0);

  return () => clearTimeout(timer);
};

/** Fixture snapshots arrive on the next tick, as a feed's first item would. */
export const fixtureDataApi = (extra: FixtureTables = {}): DataApi => ({
  watchSources: (_at, on) => {
    const timer = setTimeout(() => on.next(FIXTURE_SOURCES), 0);

    return () => clearTimeout(timer);
  },
  watchQueryLog: (_at, on) => {
    const timer = setTimeout(() => on.next(FIXTURE_QUERY_LOG), 0);

    return () => clearTimeout(timer);
  },
  describe: async (_at, { source, table, sample }) => {
    const reached = reach(source);

    if (!reached.ok) return reached;

    if (table === undefined) return { ok: true, value: FIXTURE_SCHEMA };
    const own = extra[table]?.detail;
    const detail = own ?? fixtureTable(table, sampleOf(table, sample));

    return detail === null
      ? fail("NotFound", `No table named ${table}`)
      : { ok: true, value: detail };
  },
  query: async (_at, { source, sql, limit }) => {
    const reached = reach(source);

    return reached.ok ? runFixtureQuery(sql, limit, extra) : reached;
  },
  queryStream: (_at, { source, sql, limit = STREAM_CAP }, on) => {
    const reached = reach(source);
    const selected = reached.ok ? select(sql, extra) : reached;

    if (selected.ok) return stream(selected.value, limit, on);
    const timer = setTimeout(() => on.failed(selected.error), 0);

    return () => clearTimeout(timer);
  },
});
