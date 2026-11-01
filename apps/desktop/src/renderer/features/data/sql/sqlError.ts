/**
 * Where a database error points in the query: the Host's `position`, else its `line`, else a
 * quoted name the message gives when it occurs exactly once outside literals. Null when unknown.
 */
import type { IpcError } from "../../../../shared/api.ts";
import { maskLiterals } from "./literals.ts";

export interface ErrorSpan {
  /** Offsets into the query text, `to` exclusive. */
  readonly from: number;
  readonly to: number;
  /** 1-based, for "Line 3, column 12". */
  readonly line: number;
  readonly column: number;
}

/** A Data failure over IPC: a 1-based character `position` (Postgres) or `line` (MySQL). */
export type DataIpcError = IpcError & { readonly position?: number; readonly line?: number };

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

/** Only a line: its first token outside a comment. */
const lineOnly = (sql: string, line: number | undefined): ErrorSpan | null => {
  if (line === undefined || !Number.isInteger(line) || line < 1) return null;
  const start = lineStart(sql, line);

  if (start === null) return null;
  const end = sql.indexOf("\n", start);
  const token = /\S/.exec(maskLiterals(sql).slice(start, end === -1 ? undefined : end));

  return token === null
    ? null
    : spanAt(sql, start + token.index, wordLength(sql, start + token.index));
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Postgres' `column "total" does not exist`: marked only when the query names it once. */
const quotedName = (sql: string, message: string): ErrorSpan | null => {
  const name = /"([^"]+)"/.exec(message)?.[1];

  if (name === undefined) return null;
  const pattern = new RegExp(`(^|[^\\w$"])("?${escape(name)}"?)(?![\\w$])`, "gi");
  const found = [...maskLiterals(sql).matchAll(pattern)];
  const only = found.length === 1 ? found[0] : undefined;

  if (only === undefined) return null;
  const at = only.index + (only[1]?.length ?? 0);

  return spanAt(sql, at, only[2]?.length ?? name.length);
};

const inQuery = (sql: string, position: number | undefined): position is number =>
  position !== undefined && Number.isInteger(position) && position >= 1 && position <= sql.length;

export const errorSpan = (sql: string, error: IpcError): ErrorSpan | null => {
  // SAFETY: optional fields Data's IPC mapper adds; each is used only as an in-range integer.
  const { position, line } = error as DataIpcError;

  if (inQuery(sql, position)) return spanAt(sql, position - 1, wordLength(sql, position - 1));

  return lineOnly(sql, line) ?? quotedName(sql, error.message);
};
