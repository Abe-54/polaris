/** SQL boundary from the verified ENG-644 matrix; the database still enforces read-only. */
import { DataError } from "@polaris/protocol";

export interface LexicalMode {
  readonly engine: "postgres" | "mysql";
  readonly sqlMode?: string | null;
  readonly standardConformingStrings?: boolean;
}

const refuse = (rule: string): never => {
  throw new DataError({
    code: "E-DATA-READ-ONLY",
    message: "This statement cannot run through the read-only Query path.",
    fix: rule,
  });
};

function quoteEnd(sql: string, start: number, quote: string, escapes: boolean): number {
  let i = start + 1;

  while (i < sql.length) {
    if (escapes && sql[i] === "\\") {
      i += 2;
      continue;
    }

    if (sql[i] !== quote) {
      i++;
      continue;
    }

    if (sql[i + 1] === quote) {
      i += 2;
      continue;
    }

    return i + 1;
  }

  return refuse("Close the quoted SQL value or identifier.");
}

function commentEnd(sql: string, start: number, nested: boolean): number {
  let depth = 1;
  let i = start + 2;

  while (i < sql.length && depth > 0) {
    const pair = sql.slice(i, i + 2);

    if (nested && pair === "/*") {
      depth++;
      i += 2;
    } else if (pair === "*/") {
      depth--;
      i += 2;
    } else i++;
  }

  if (depth) refuse("Close the SQL block comment.");

  return i;
}

function literalEnd(sql: string, i: number, mode: LexicalMode): number | null {
  const quote = sql[i]!;
  const pg = mode.engine === "postgres";

  if (["'", '"', "`"].includes(quote)) {
    const modes = new Set((mode.sqlMode ?? "").split(","));
    const pgEscapes = /[eE]/.test(sql[i - 1] ?? "") && !/[a-z0-9_$]/i.test(sql[i - 2] ?? "");

    const escapes = pg
      ? quote === "'" && (pgEscapes || mode.standardConformingStrings === false)
      : !modes.has("NO_BACKSLASH_ESCAPES") &&
        quote !== "`" &&
        !(quote === '"' && modes.has("ANSI_QUOTES"));

    return quoteEnd(sql, i, quote, escapes);
  }

  if (!pg || quote !== "$" || /[a-z0-9_$]/i.test(sql[i - 1] ?? "")) return null;
  const delimiter = sql.slice(i).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0];

  if (!delimiter) return null;
  const end = sql.indexOf(delimiter, i + delimiter.length);

  if (end < 0) refuse("Close the PostgreSQL dollar-quoted value.");

  return end + delimiter.length;
}

export interface Token {
  end: number;
  token?: string;
}

export function tokenAt(sql: string, i: number, mode: LexicalMode): Token {
  const pg = mode.engine === "postgres";

  if (/\s/.test(sql[i]!)) return { end: i + 1 };
  const pair = sql.slice(i, i + 2);

  if (pair === "/*") return { end: commentEnd(sql, i, pg) };
  const line = pair === "--" && (pg || /\s/.test(sql[i + 2] ?? " "));

  if (line || (!pg && sql[i] === "#")) {
    const end = sql.indexOf("\n", i);

    return { end: end < 0 ? sql.length : end + 1 };
  }

  const literal = literalEnd(sql, i, mode);

  if (literal !== null) return { end: literal, token: "literal" };
  const word = sql.slice(i).match(/^[a-z_][a-z0-9_$]*/i)?.[0];

  return { end: i + (word?.length ?? 1), token: word?.toUpperCase() ?? sql[i]! };
}

/** Returns SQL without its optional terminator, for safe nesting in a capped query. */
function mysqlRawGuard(sql: string, mode: LexicalMode) {
  if (/\/\*!|\/\*\+|\/\*[mM]!/.test(sql))
    refuse("Remove executable comments and optimizer hints (/*! and /*+).");

  if (/OUTFILE|DUMPFILE|LOAD_FILE/i.test(sql))
    refuse("Remove OUTFILE, DUMPFILE and LOAD_FILE, including from comments and literals.");

  if (mode.sqlMode == null && /[\\"]/.test(sql))
    refuse("SQL mode is unavailable; remove backslashes and double quotes or reconnect.");
}

function singleStatement(sql: string, mode: LexicalMode) {
  let i = 0;
  let terminator: number | undefined;
  let keyword = "";

  while (i < sql.length) {
    const next = tokenAt(sql, i, mode);

    if (next.token !== undefined) {
      if (terminator !== undefined)
        refuse("Use exactly one SQL statement with at most one trailing semicolon.");

      if (next.token === ";") terminator = i;
      else if (!keyword && next.token !== "(") keyword = next.token;
    }

    i = next.end;
  }

  return { terminator, keyword };
}

export function guardSql(sql: string, mode: LexicalMode, write = false) {
  if (mode.engine === "mysql") mysqlRawGuard(sql, mode);
  const { terminator, keyword } = singleStatement(sql, mode);

  if (!keyword) refuse("Supply one SQL statement.");

  if (
    !write &&
    mode.engine === "mysql" &&
    !["SELECT", "WITH", "TABLE", "VALUES", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(keyword)
  )
    refuse(
      "MySQL read-only Queries must start with SELECT, WITH, TABLE, VALUES, SHOW, DESCRIBE or EXPLAIN."
    );

  return { sql: terminator === undefined ? sql : sql.slice(0, terminator), keyword };
}
