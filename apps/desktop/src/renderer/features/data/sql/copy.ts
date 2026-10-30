/** The SQL tab's words: the results kicker, a database error's lines and the schema line. */
import type { ResultSet } from "./state.ts";
import type { DataIpcError, ErrorSpan } from "./sqlError.ts";

const count = (n: number) => n.toLocaleString("en-US");

const plural = (n: number, one: string) => `${count(n)} ${n === 1 ? one : `${one}s`}`;

const ms = (elapsed: number) => `${Math.round(elapsed)} ms`;

/** "Results · 5 rows · 9 ms", "Results · first 200 of 1,312 rows · 9 ms". */
export const resultsKicker = (result: ResultSet): string => {
  const shown = !result.truncated
    ? plural(result.returned, "row")
    : result.total === undefined
      ? `first ${plural(result.returned, "row")}`
      : `first ${count(result.returned)} of ${plural(result.total, "row")}`;

  return `Results · ${shown} · ${ms(result.elapsedMs)}`;
};

export interface ErrorLines {
  readonly message: string;
  /** "Line 3, column 12"; null when the error points nowhere. */
  readonly where: string | null;
  /** What to do about it, when the Host says. */
  readonly fix: string | null;
}

export const sqlErrorLines = (
  error: DataIpcError & { readonly fix?: string },
  span: ErrorSpan | null
): ErrorLines => ({
  message: error.message,
  where: span === null ? null : `Line ${span.line}, column ${span.column}`,
  fix: error.fix === undefined || error.fix.trim() === "" ? null : error.fix,
});

const ago = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m ago`;

  return `${Math.floor(minutes / 60)}h ago`;
};

/** "Schema loaded 4s ago · 7 tables", with "· 500 shown" when the read was capped. */
export const schemaLine = (
  tree: {
    readonly loadedAt: string;
    readonly schemas: ReadonlyArray<{
      readonly tables: ReadonlyArray<unknown>;
      readonly views: ReadonlyArray<unknown>;
    }>;
    readonly truncatedTables: number;
  },
  now: number
): string => {
  const tables = tree.schemas.reduce((n, s) => n + s.tables.length + s.views.length, 0);
  const loaded = `Schema loaded ${ago(now - Date.parse(tree.loadedAt))}`;

  if (tree.truncatedTables > 0)
    return `${loaded} · ${count(tables)} of ${plural(tables + tree.truncatedTables, "table")}`;

  return `${loaded} · ${plural(tables, "table")}`;
};
