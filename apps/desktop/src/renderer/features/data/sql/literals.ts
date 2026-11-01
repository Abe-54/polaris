/**
 * SQL with its string literals and comments blanked to spaces, offsets kept, so keyword and name
 * searches never match inside `'…'`, `$$…$$`, `-- …` or `/* … *\/`. Quoted identifiers stay.
 */

const DOLLAR = /^\$([A-Za-z_]\w*)?\$/;

/** Where the literal or comment starting at `at` ends (exclusive), or null when none starts. */
const skipFrom = (sql: string, at: number): number | null => {
  const two = sql.slice(at, at + 2);

  if (two === "--") {
    const end = sql.indexOf("\n", at);

    return end === -1 ? sql.length : end;
  }

  if (two === "/*") {
    const end = sql.indexOf("*/", at + 2);

    return end === -1 ? sql.length : end + 2;
  }

  if (sql[at] === "'") return quotedEnd(sql, at);

  const tag = sql[at] === "$" ? DOLLAR.exec(sql.slice(at))?.[0] : undefined;

  if (tag === undefined) return null;
  const end = sql.indexOf(tag, at + tag.length);

  return end === -1 ? sql.length : end + tag.length;
};

/** A `'…'` literal's end; `''` and `\'` stay inside it. */
const quotedEnd = (sql: string, at: number): number => {
  let i = at + 1;

  while (i < sql.length) {
    if (sql[i] === "\\") i += 2;
    else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
    else if (sql[i] === "'") return i + 1;
    else i++;
  }

  return sql.length;
};

/** The same text, each literal and comment replaced by as many spaces (newlines kept). */
export const maskLiterals = (sql: string): string => {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const char = sql[i] ?? "";

    // A quoted identifier is kept whole, so a quote or dash inside it starts nothing.
    if (char === '"' || char === "`") {
      const close = sql.indexOf(char, i + 1);
      const end = close === -1 ? sql.length : close + 1;

      out += sql.slice(i, end);
      i = end;
      continue;
    }

    const end = skipFrom(sql, i);

    if (end === null) {
      out += sql[i];
      i++;
      continue;
    }

    out += sql.slice(i, end).replace(/[^\n]/g, " ");
    i = end;
  }

  return out;
};
