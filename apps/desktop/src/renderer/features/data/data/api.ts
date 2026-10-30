/**
 * Data's boundary: the four calls Data mode makes (sources and Query Log watches, describe,
 * query). `liveDataApi` goes over IPC (shared/dataContract.ts); fixtures swap in for previews.
 */
import type {
  DataSource,
  QueryLogEntry,
  QueryResult,
  SchemaTree,
  TableDetail,
} from "@polaris/protocol";
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
};
