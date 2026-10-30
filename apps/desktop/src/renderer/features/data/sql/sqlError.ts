/**
 * Where a database error points in the query: the Host's position when it sends one, else what
 * the message names (MySQL's "near '…' at line N", a quoted identifier). Null when unknown.
 */
import type { IpcError } from "../../../../shared/api.ts";

export interface ErrorSpan {
  /** Offsets into the query text, `to` exclusive. */
  readonly from: number;
  readonly to: number;
  /** 1-based, for "Line 3, column 12". */
  readonly line: number;
  readonly column: number;
}

/** The structured position, once the contract carries one (1-based character offset). */
export type DataIpcError = IpcError & { readonly position?: number };

const IDENT = /[\w$]/;

const spanAt = (sql: string, from: number, length: number): ErrorSpan => {
  const before = sql.slice(0, from);
  const line = before.split("\n").length;
  const column = from - (before.lastIndexOf("\n") + 1) + 1;

  return { from, to: Math.min(sql.length, from + Math.max(1, length)), line, column };
};

/** The word starting at `from`, so the mark covers the token rather than one character. */
const wordLength = (sql: string, from: number) => {
  let end = from;

  while (end < sql.length && IDENT.test(sql[end] ?? "")) end++;

  return Math.max(1, end - from);
};

const lineStart = (sql: string, line: number) => {
  let at = 0;

  for (let n = 1; n < line; n++) {
    const next = sql.indexOf("\n", at);

    if (next === -1) return null;
    at = next + 1;
  }

  return at;
};

/** MySQL: "… near 'totl from invoices' at line 1". */
const mysqlNear = (sql: string, message: string): ErrorSpan | null => {
  const near = /near '([\s\S]*?)' at line (\d+)/.exec(message);

  if (near === null) return null;
  const start = lineStart(sql, Number(near[2]));
  const snippet = near[1] ?? "";

  if (start === null) return null;
  const at = snippet === "" ? -1 : sql.indexOf(snippet, start);

  return at === -1 ? null : spanAt(sql, at, wordLength(sql, at));
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Postgres: `column "total" does not exist`, `relation "invoice" does not exist`. */
const quotedName = (sql: string, message: string): ErrorSpan | null => {
  const name = /"([^"]+)"/.exec(message)?.[1];

  if (name === undefined) return null;
  const found = new RegExp(`(^|[^\\w$"])("?${escape(name)}"?)(?![\\w$])`, "i").exec(sql);

  if (found === null) return null;
  const at = found.index + (found[1]?.length ?? 0);

  return spanAt(sql, at, found[2]?.length ?? name.length);
};

export const errorSpan = (sql: string, error: IpcError): ErrorSpan | null => {
  // SAFETY: an optional field the contract may add; used only as an integer within the query.
  const { position } = error as DataIpcError;

  if (
    Number.isInteger(position) &&
    position !== undefined &&
    position >= 1 &&
    position <= sql.length
  )
    return spanAt(sql, position - 1, wordLength(sql, position - 1));

  return mysqlNear(sql, error.message) ?? quotedName(sql, error.message);
};
