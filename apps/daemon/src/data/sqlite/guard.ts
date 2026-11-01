/** SQLite's read boundary: one statement, a read keyword; the read-only handle enforces the rest. */
import { DataError } from "@polaris/protocol";

const refuse = (fix: string): never => {
  throw new DataError({
    code: "E-DATA-READ-ONLY",
    message: "This statement cannot run through the read-only Query path.",
    fix,
  });
};

const closers = new Map([
  ["'", "'"],
  ['"', '"'],
  ["`", "`"],
  ["[", "]"],
]);

/** The end of the quoted token starting at `start`; a doubled closer is an escape. */
function quotedEnd(sql: string, start: number): number {
  const close = closers.get(sql[start]!)!;

  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== close) continue;

    if (close !== "]" && sql[i + 1] === close) i++;
    else return i + 1;
  }

  return refuse("Close every quoted string and identifier.");
}

function skipTrivia(sql: string, start: number): number {
  let i = start;

  while (i < sql.length) {
    if (/\s/.test(sql[i]!)) i++;
    else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else break;
  }

  return i;
}

export interface SqliteToken {
  readonly text: string;
  /** Uppercased for bare words; quoted tokens keep their quotes. */
  readonly word: string;
  readonly start: number;
}

export function sqliteTokens(sql: string): SqliteToken[] {
  const tokens: SqliteToken[] = [];

  for (let i = skipTrivia(sql, 0); i < sql.length; i = skipTrivia(sql, i)) {
    const char = sql[i]!;
    let end: number;

    if (closers.has(char)) end = quotedEnd(sql, i);
    else if (/[\w$]/.test(char)) {
      end = i + 1;

      while (end < sql.length && /[\w$]/.test(sql[end]!)) end++;
    } else end = i + 1;
    const text = sql.slice(i, end);
    tokens.push({ text, word: closers.has(char) ? text : text.toUpperCase(), start: i });
    i = end;
  }

  return tokens;
}

const READ_KEYWORDS = ["SELECT", "WITH", "VALUES", "EXPLAIN"];

/** One read statement without its trailing semicolon, and its leading keyword. */
export function guardSqliteRead(sql: string) {
  const tokens = sqliteTokens(sql);
  const terminator = tokens.findIndex((token) => token.word === ";");

  if (terminator !== -1 && terminator !== tokens.length - 1)
    refuse("Use exactly one SQL statement with at most one trailing semicolon.");
  const keyword = tokens.find((token) => token.word !== "(")?.word;

  if (keyword === undefined) return refuse("Supply one SQL statement.");

  if (!READ_KEYWORDS.includes(keyword))
    refuse("SQLite read-only Queries must start with SELECT, WITH, VALUES or EXPLAIN.");

  return {
    sql: terminator === -1 ? sql : sql.slice(0, tokens[terminator]!.start),
    keyword,
  };
}
