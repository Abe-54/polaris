/**
 * A `DataApi` over the fixtures, for `<DataLayer api={fixtureDataApi()}>` in previews and tests.
 * Queries read `select … from <table> [where <column> = '<value>']`; writes are refused.
 */
import { DataSource, type QueryLogEntry, QueryResult, type SchemaTree } from "@polaris/protocol";
import { Schema } from "effect";
import type { IpcError, Result } from "../../../../shared/api.ts";
import type { DataApi, SaveSourceInput, Snapshots, TableChange } from "../data/api.ts";
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
const reach = (name: string, sources: ReadonlyArray<DataSource>): Result<null> => {
  const source = sources.find((s) => s.name === name);

  if (source !== undefined && !source.reachable)
    return fail("E-DATA-UNREACHABLE", source.error ?? `Can't reach ${source.host}:${source.port}`);

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
      rowCount: rows.length,
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

/** What a fixture api serves; the defaults are the ledger checkout (fixtures.ts). */
export interface FixtureData {
  readonly sources?: ReadonlyArray<DataSource>;
  readonly queryLog?: ReadonlyArray<QueryLogEntry>;
  /** A source's schema tree by name; the ledger schema for every source when omitted. */
  readonly schema?: (source: string) => SchemaTree;
  readonly tableChanges?: ReadonlyArray<TableChange>;
}

/** An agent added `currencies` on app this Turn (D1's tree). */
export const FIXTURE_TABLE_CHANGES: ReadonlyArray<TableChange> = [
  { source: "app", schema: "public", table: "currencies", change: "added" },
];

/** A feed of whole snapshots that re-sends when the fixture changes, as a Host's would. */
const feed = <A>(initial: ReadonlyArray<A>) => {
  let value = initial;
  const listeners = new Set<(snapshot: ReadonlyArray<A>) => void>();

  return {
    get: () => value,
    set: (next: ReadonlyArray<A>) => {
      value = next;

      for (const listener of listeners) listener(next);
    },
    watch: (on: Snapshots<A>) => {
      const timer = setTimeout(() => {
        listeners.add(on.next);
        on.next(value);
      }, 0);

      return () => {
        clearTimeout(timer);
        listeners.delete(on.next);
      };
    },
  };
};

const LOOPBACK = /^(localhost|127\.|::1$)/;

const savedSource = (input: SaveSourceInput) =>
  new DataSource({
    id: `src-manual-${input.name}`,
    name: input.name,
    engine: input.engine,
    locality: LOOPBACK.test(input.host) ? "local" : "remote",
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    foundIn: { kind: "manual" },
    access: LOOPBACK.test(input.host) ? "read" : "needs-approval",
    writes: "ask",
    label: input.label,
    reachable: true,
  });

/** Fixture snapshots arrive on the next tick, as a feed's first item would. */
export const fixtureDataApi = (data: FixtureData = {}): DataApi => {
  const sources = feed(data.sources ?? FIXTURE_SOURCES);
  const queryLog = feed(data.queryLog ?? FIXTURE_QUERY_LOG);
  const changes = feed(data.tableChanges ?? FIXTURE_TABLE_CHANGES);

  return {
    watchSources: (_at, on) => sources.watch(on),
    watchQueryLog: (_at, on) => queryLog.watch(on),
    watchTableChanges: (_at, on) => changes.watch(on),
    describe: async (_at, { source, table, sample }) => {
      const reached = reach(source, sources.get());

      if (!reached.ok) return reached;

      if (table === undefined) return { ok: true, value: data.schema?.(source) ?? FIXTURE_SCHEMA };
      const detail = fixtureTable(table, sampleOf(table, sample));

      return detail === null
        ? fail("NotFound", `No table named ${table}`)
        : { ok: true, value: detail };
    },
    query: async (_at, { source, sql, limit }) => {
      const reached = reach(source, sources.get());

      return reached.ok ? runFixtureQuery(sql, limit) : reached;
    },
    saveSource: async (_at, input) => {
      const saved = savedSource(input);

      sources.set([...sources.get().filter((s) => s.name !== input.name), saved]);

      return { ok: true, value: saved };
    },
    labelSource: async (_at, name, label) => {
      const source = sources.get().find((s) => s.name === name);

      if (source === undefined)
        return fail("E-DATA-UNKNOWN-SOURCE", `No data source named ${name}`);
      const labelled = new DataSource({ ...Schema.encodeSync(DataSource)(source), label });

      sources.set(sources.get().map((s) => (s.name === name ? labelled : s)));

      return { ok: true, value: labelled };
    },
  };
};
