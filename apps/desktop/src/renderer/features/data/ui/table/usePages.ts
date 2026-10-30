/**
 * The Table tab's rows, a page at a time up to the 10,000-row cap: each page is one Query, streamed
 * where the Daemon serves data.query.stream (1,000 rows) and through data.query otherwise (200).
 */
import { Option } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IpcError } from "../../../../../shared/api.ts";
import type { DataApi } from "../../data/api.ts";
import { useDataApi } from "../../data/hooks.tsx";
import type { GridColumn } from "../../grid/columns.ts";
import { type DataRow, decodeRows } from "../../grid/value.ts";
import type { DataSessionKey } from "../../model/store.ts";

export const ROW_CAP = 10_000;

export const STREAM_PAGE = 1_000;

/** data.query's most rows. */
export const QUERY_PAGE = 200;

export interface Pages {
  readonly status: "loading" | "ready" | "failed";
  readonly columns: ReadonlyArray<GridColumn> | null;
  readonly rows: ReadonlyArray<DataRow>;
  /** A page is on its way. */
  readonly fetching: boolean;
  /** No more rows: the last page came back short, or the cap was reached. */
  readonly done: boolean;
  readonly elapsedMs: number;
  readonly error: IpcError | null;
}

const INITIAL: Pages = {
  status: "loading",
  columns: null,
  rows: [],
  fetching: true,
  done: false,
  elapsedMs: 0,
  error: null,
};

export interface PageRequest {
  readonly source: string;
  /** The page's SQL, given its size and offset. */
  readonly sql: (limit: number, offset: number) => string;
  /** Changes when the rows should start over (another table or filter). */
  readonly key: string;
}

interface PageResult {
  readonly columns?: ReadonlyArray<GridColumn>;
  readonly rows: ReadonlyArray<DataRow>;
}

interface PageHandlers {
  readonly chunk: (result: PageResult) => void;
  readonly end: (returned: number, elapsedMs: number) => void;
  readonly failed: (error: IpcError) => void;
}

const BAD_ROWS: IpcError = {
  code: "E-DATA-SQL",
  message: "The result had a value Polaris can't show",
};

/** One page through whichever call the api has; returns its cancel. */
const fetchPage = (
  api: DataApi,
  at: DataSessionKey,
  request: PageRequest,
  offset: number,
  on: PageHandlers
): (() => void) => {
  if (api.queryStream !== undefined) {
    const limit = Math.min(STREAM_PAGE, ROW_CAP - offset);

    return api.queryStream(
      at,
      { source: request.source, sql: request.sql(limit, offset), limit },
      {
        header: ({ columns }) => on.chunk({ columns, rows: [] }),
        rows: (rows) => on.chunk({ rows }),
        end: ({ returned, elapsedMs }) => on.end(returned, elapsedMs),
        failed: on.failed,
      }
    );
  }

  let live = true;
  const limit = Math.min(QUERY_PAGE, ROW_CAP - offset);

  void api
    .query(at, { source: request.source, sql: request.sql(limit, offset), limit })
    .then((result) => {
      if (!live) return;

      if (!result.ok) return on.failed(result.error);
      const rows = Option.getOrNull(decodeRows(result.value.rows));

      if (rows === null) return on.failed(BAD_ROWS);
      on.chunk({ columns: result.value.columns, rows });
      on.end(rows.length, result.value.elapsedMs);
    });

  return () => {
    live = false;
  };
};

const pageSize = (api: DataApi) => (api.queryStream === undefined ? QUERY_PAGE : STREAM_PAGE);

export const usePages = (at: DataSessionKey, request: PageRequest | null) => {
  const api = useDataApi();
  const [pages, setPages] = useState<Pages>(INITIAL);
  const cancel = useRef<(() => void) | null>(null);
  const latest = useRef(request);
  const { hostKey, sessionId } = at;

  const shown = useRef(pages);

  latest.current = request;
  shown.current = pages;

  const load = useCallback(
    (offset: number) => {
      const current = latest.current;

      if (current === null) return;
      const asked = Math.min(pageSize(api), ROW_CAP - offset);

      cancel.current?.();
      cancel.current = fetchPage(api, { hostKey, sessionId }, current, offset, {
        chunk: ({ columns, rows }) =>
          setPages((p) => ({
            ...p,
            status: "ready",
            columns: columns ?? p.columns,
            rows: rows.length === 0 ? p.rows : [...p.rows, ...rows],
          })),
        end: (returned, elapsedMs) =>
          setPages((p) => ({
            ...p,
            status: "ready",
            fetching: false,
            elapsedMs: p.elapsedMs + elapsedMs,
            done: returned < asked || offset + returned >= ROW_CAP,
          })),
        failed: (error) =>
          setPages((p) => ({ ...p, status: "failed", fetching: false, done: true, error })),
      });
    },
    [api, hostKey, sessionId]
  );

  const key = request?.key ?? null;

  useEffect(() => {
    setPages(INITIAL);

    if (key !== null) load(0);

    return () => {
      cancel.current?.();
      cancel.current = null;
    };
  }, [key, load]);

  /** The next page, unless one is on its way or there are no more. */
  const more = useCallback(() => {
    const p = shown.current;

    if (p.fetching || p.done || p.status !== "ready") return;
    shown.current = { ...p, fetching: true };
    setPages((now) => ({ ...now, fetching: true }));
    load(p.rows.length);
  }, [load]);

  return { pages, more };
};
