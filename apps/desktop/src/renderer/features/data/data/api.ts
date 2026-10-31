/**
 * Data's boundary: the four calls Data mode makes (sources and Query Log watches, describe,
 * query). `liveDataApi` goes over IPC (shared/dataContract.ts); fixtures swap in for previews.
 */
import type {
  DataSource,
  DataSourceLabel,
  QueryLogEntry,
  QueryResult,
  SchemaTree,
  TableDetail,
} from "@polaris/protocol";
import { Match } from "effect";
import type { IpcError, Result } from "../../../../shared/api.ts";
import { polaris } from "../../bridge.ts";
import type { DataRow } from "../grid/value.ts";
import type { DataSessionKey } from "../model/store.ts";

export interface Snapshots<A> {
  /** The latest snapshot; each one replaces the last. */
  readonly next: (snapshot: ReadonlyArray<A>) => void;
  readonly end?: (error: IpcError | null) => void;
}

export interface DescribeInput {
  readonly source: string;
  /** A table's detail; the whole schema tree when omitted. */
  readonly table?: string | undefined;
  /** Sample rows with a table's detail, 0–20. */
  readonly sample?: number | undefined;
}

export interface QueryInput {
  readonly source: string;
  readonly sql: string;
  /** Rows returned, 1–200. */
  readonly limit?: number;
}

export interface QueryStreamInput {
  readonly source: string;
  readonly sql: string;
  /** Rows returned, 1–10,000. */
  readonly limit?: number;
}

/** data.query.stream's items (CF, ENG-644) as callbacks: a header, rows in chunks, then the end. */
export interface QueryStream {
  readonly header: (header: {
    readonly queryId: string;
    readonly columns: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  }) => void;
  readonly rows: (rows: ReadonlyArray<DataRow>) => void;
  readonly end: (end: {
    readonly returned: number;
    /** The full count, when the database said. */
    readonly total?: number | undefined;
    readonly truncated: boolean;
    readonly elapsedMs: number;
  }) => void;
  readonly failed: (error: IpcError) => void;
}

/** A manual Data Source (`data.source.save`); the password is write-only and never read back. */
export interface SaveSourceInput {
  readonly name: string;
  readonly engine: DataSource["engine"];
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  readonly label: DataSourceLabel;
}

/** A table an agent added or changed in its current Turn, for the tree's git letter. */
export interface TableChange {
  /** The Data Source's name. */
  readonly source: string;
  readonly schema: string;
  readonly table: string;
  readonly change: "added" | "modified";
}

export interface DataApi {
  readonly watchSources: (at: DataSessionKey, on: Snapshots<DataSource>) => () => void;
  readonly watchQueryLog: (at: DataSessionKey, on: Snapshots<QueryLogEntry>) => () => void;
  readonly describe: (
    at: DataSessionKey,
    input: DescribeInput
  ) => Promise<Result<SchemaTree | TableDetail>>;
  readonly query: (at: DataSessionKey, input: QueryInput) => Promise<Result<QueryResult>>;
  /** Streams a read to the 10,000-row cap; the returned function cancels it. Absent until served. */
  readonly queryStream?: (
    at: DataSessionKey,
    input: QueryStreamInput,
    on: QueryStream
  ) => () => void;
  readonly saveSource: (at: DataSessionKey, input: SaveSourceInput) => Promise<Result<DataSource>>;
  readonly labelSource: (
    at: DataSessionKey,
    source: string,
    label: DataSourceLabel
  ) => Promise<Result<DataSource>>;
  /** Tables changed this Turn; no Host serves them yet, so the live feed stays empty. */
  readonly watchTableChanges: (at: DataSessionKey, on: Snapshots<TableChange>) => () => void;
}

const session = (at: DataSessionKey) => ({ hostKey: at.hostKey, sessionId: at.sessionId });

/** A watch's items are whole snapshots: only the batch's last one matters. */
const latest = <A>(on: Snapshots<A>) => ({
  items: (items: ReadonlyArray<ReadonlyArray<A>>) => {
    const last = items.at(-1);

    if (last !== undefined) on.next(last);
  },
  end: (error: IpcError | null) => on.end?.(error),
});

export const liveDataApi: DataApi = {
  watchSources: (at, on) => polaris().subscribe("data.sources.watch", session(at), latest(on)),
  watchQueryLog: (at, on) => polaris().subscribe("data.queryLog.watch", session(at), latest(on)),
  describe: (at, { source, table, sample }) => {
    const base = { ...session(at), source };
    const withTable = table === undefined ? base : { ...base, table };

    return polaris().request(
      "data.describe",
      sample === undefined ? withTable : { ...withTable, sample }
    );
  },
  query: (at, input) => polaris().request("data.query", { ...session(at), ...input }),
  queryStream: (at, { source, sql, limit }, on) => {
    const base = { ...session(at), source, sql };

    return polaris().subscribe(
      "data.query.stream",
      limit === undefined ? base : { ...base, limit },
      {
        items: (items) => {
          for (const item of items)
            Match.valueTags(item, {
              Header: (header) => on.header(header),
              Rows: ({ rows }) => on.rows(rows),
              End: (end) => on.end(end),
            });
        },
        end: (error) => {
          if (error !== null) on.failed(error);
        },
      }
    );
  },
  saveSource: (at, input) => polaris().request("data.source.save", { ...session(at), ...input }),
  labelSource: (at, source, label) =>
    polaris().request("data.source.label", { ...session(at), source, label }),
  watchTableChanges: (_at, on) => {
    on.next([]);

    return () => undefined;
  },
};
