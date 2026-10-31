/**
 * A `DataApi` over the fixtures, for `<DataLayer api={fixtureDataApi()}>` in previews and tests.
 * Queries read `select … from <table> [where <column> = '<value>']`; writes are refused.
 */
import { QueryResult } from "@polaris/protocol";
import type { IpcError, Result } from "../../../../shared/api.ts";
import type { DataApi } from "../data/api.ts";
import {
  FIXTURE_QUERY_LOG,
  FIXTURE_SCHEMA,
  FIXTURE_SOURCES,
  fixtureColumns,
  fixtureRows,
  fixtureTable,
} from "./fixtures.ts";

const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  error: { code, message } satisfies IpcError,
});

const DEFAULT_LIMIT = 200;

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

/** Runs the fixture's small SQL subset; exported for the tests. */
export const runFixtureQuery = (sql: string, limit = DEFAULT_LIMIT): Result<QueryResult> => {
  if (!/^\s*(select|with)\b/i.test(sql))
    return fail("E-DATA-READ-ONLY", "Fixture data sources are read-only");
  const table = FROM.exec(sql)?.[1];
  const columns = table === undefined ? null : fixtureColumns(table);
  const all = table === undefined ? null : fixtureRows(table);

  if (table === undefined || columns === null || all === null)
    return fail("E-DATA-SQL", `relation "${table ?? "?"}" does not exist`);
  const where = WHERE.exec(sql);
  const at = where === null ? -1 : columns.findIndex((c) => c.name === where[1]);
  const rows = at === -1 ? all : all.filter((row) => row[at] === where?.[2]);

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

/** Fixture snapshots arrive on the next tick, as a feed's first item would. */
export const fixtureDataApi = (): DataApi => ({
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
    const detail = fixtureTable(table, sampleOf(table, sample));

    return detail === null
      ? fail("NotFound", `No table named ${table}`)
      : { ok: true, value: detail };
  },
  query: async (_at, { source, sql, limit }) => {
    const reached = reach(source);

    return reached.ok ? runFixtureQuery(sql, limit) : reached;
  },
});
