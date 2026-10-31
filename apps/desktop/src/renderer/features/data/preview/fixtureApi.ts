/**
 * A `DataApi` over the fixtures, for `<DataLayer api={fixtureDataApi()}>` in previews and tests.
 * Queries read `select … from <table> [where <column> = '<value>']`; writes are refused. A scene
 * can add tables of its own (the bench's 10,000 rows, the worst case's 60 columns).
 */
import {
  DataSource,
  type QueryLogEntry,
  QueryResult,
  type SchemaTree,
  type TableDetail,
} from "@polaris/protocol";
import { Schema } from "effect";
import type { IpcError, Result } from "../../../../shared/api.ts";
import type { DataApi, QueryStream, SaveSourceInput, Snapshots, TableChange } from "../data/api.ts";
import { cellOf, type DataRow } from "../grid/value.ts";
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

const STREAM_CAP = 10_000;

/** data.query.stream's chunk: CF's Rows items hold at most 500. */
const CHUNK = 500;

/** A scene's own table: its detail (columns, keys) and every row. */
export interface FixtureTable {
  readonly detail: TableDetail;
  readonly rows: ReadonlyArray<DataRow>;
}

export type FixtureTables = Readonly<Record<string, FixtureTable>>;

/** The source by name, or why an agent-facing call can't reach it. */
const reach = (name: string, sources: ReadonlyArray<DataSource>): Result<null> => {
  const source = sources.find((s) => s.name === name);

  if (source?.reachable === false)
    return fail("E-DATA-UNREACHABLE", source.error ?? `Can't reach ${source.host}:${source.port}`);

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
  const rows = fixtureRows(table);

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
  /** A scene's own tables, read before the ledger's. */
  readonly tables?: FixtureTables;
  /** What each subscribe re-lists, as the Daemon re-discovers then; current sources when omitted. */
  readonly relist?: () => ReadonlyArray<DataSource>;
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

/** A saved source is remote until its Host says otherwise, as the Daemon fails closed. */
const savedSource = (input: SaveSourceInput) =>
  new DataSource({
    id: `src-manual-${input.name}`,
    name: input.name,
    engine: input.engine,
    locality: "remote",
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    foundIn: { kind: "manual" },
    access: "needs-approval",
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
    watchSources: (_at, on) => {
      if (data.relist !== undefined) sources.set(data.relist());

      return sources.watch(on);
    },
    watchQueryLog: (_at, on) => queryLog.watch(on),
    watchTableChanges: (_at, on) => changes.watch(on),
    describe: async (_at, { source, table, sample }) => {
      const reached = reach(source, sources.get());

      if (!reached.ok) return reached;

      if (table === undefined) return { ok: true, value: data.schema?.(source) ?? FIXTURE_SCHEMA };
      const detail = data.tables?.[table]?.detail ?? fixtureTable(table, sampleOf(table, sample));

      return detail === null
        ? fail("NotFound", `No table named ${table}`)
        : { ok: true, value: detail };
    },
    query: async (_at, { source, sql, limit }) => {
      const reached = reach(source, sources.get());

      return reached.ok ? runFixtureQuery(sql, limit, data.tables) : reached;
    },
    queryStream: (_at, { source, sql, limit = STREAM_CAP }, on) => {
      const reached = reach(source, sources.get());
      const selected = reached.ok ? select(sql, data.tables ?? {}) : reached;

      if (selected.ok) return stream(selected.value, limit, on);
      const timer = setTimeout(() => on.failed(selected.error), 0);

      return () => clearTimeout(timer);
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
