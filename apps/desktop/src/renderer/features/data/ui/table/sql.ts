/**
 * The Table tab's Query: `SELECT * FROM schema.t [WHERE (…)] [ORDER BY key] LIMIT n [OFFSET m]`,
 * quoted for the Data Source's engine. The filter is the user's own SQL; the Daemon runs it read-only.
 */
import type { DataSource } from "@polaris/protocol";
import { cellOf, type DataValue, unfollowable } from "../../grid/value.ts";

export type Engine = DataSource["engine"];

export const quoteIdent = (engine: Engine, name: string) =>
  engine === "mysql" ? `\`${name.replaceAll("`", "``")}\`` : `"${name.replaceAll('"', '""')}"`;

/** Words both engines reserve that tables often use as column names. */
const RESERVED = new Set([
  "all",
  "and",
  "as",
  "asc",
  "between",
  "by",
  "case",
  "check",
  "column",
  "create",
  "default",
  "desc",
  "distinct",
  "else",
  "end",
  "for",
  "from",
  "group",
  "having",
  "in",
  "is",
  "join",
  "key",
  "like",
  "limit",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "references",
  "select",
  "table",
  "then",
  "to",
  "union",
  "unique",
  "user",
  "using",
  "when",
  "where",
  "with",
]);

/**
 * A column name as the filter must spell it: Postgres folds unquoted names to lower case, and
 * neither engine reads spaces, symbols or reserved words bare.
 */
export const identFor = (engine: Engine, name: string) => {
  const plain = engine === "mysql" ? /^[A-Za-z_][\w$]*$/ : /^[a-z_][a-z0-9_$]*$/;

  return plain.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quoteIdent(engine, name);
};

/** A table as the tree and a foreign key name it: its schema (MySQL's database) and its name. */
export interface TableRef {
  readonly schema: string;
  readonly name: string;
}

/** Each part quoted on its own: `"billing"."invoices"`, never `"billing.invoices"`. */
export const qualifiedName = (engine: Engine, { schema, name }: TableRef) =>
  `${quoteIdent(engine, schema)}.${quoteIdent(engine, name)}`;

/**
 * A string literal that reads the same whatever the server's escape mode: MySQL's backslashes go
 * in as `LEFT('\\', 1)`, so `NO_BACKSLASH_ESCAPES` on or off can't change the value.
 */
export const quoteValue = (engine: Engine, raw: string) => {
  const literal = (part: string) => `'${part.replaceAll("'", "''")}'`;

  if (engine !== "mysql" || !raw.includes("\\")) return literal(raw);
  const parts = raw.split("\\").map((part) => (part === "" ? null : literal(part)));
  // '\\' is one backslash with escapes on and two without: its first character either way.
  const slash = "LEFT('\\\\', 1)";

  return `CONCAT(${parts.flatMap((part, i) => [...(i === 0 ? [] : [slash]), ...(part === null ? [] : [part])]).join(", ")})`;
};

/** The filter as typed, without a leading WHERE or trailing semicolons. */
export const cleanFilter = (filter: string) =>
  filter
    .trim()
    .replace(/^where\s+/i, "")
    .replace(/[;\s]+$/, "");

/** Where a quoted run that opened at `at` ends (past its closing quote), or -1 when it doesn't. */
const quotedEnd = (text: string, at: number, quote: string, backslash: boolean) => {
  for (let i = at + 1; i < text.length; i++) {
    const ch = text[i];

    if (backslash && ch === "\\") i++;
    else if (ch === quote && text[i + 1] === quote) i++;
    else if (ch === quote) return i + 1;
  }

  return -1;
};

/** A Postgres block comment nests; a MySQL one ends at its first close. */
const commentEnd = (text: string, at: number, nests: boolean) => {
  let depth = 0;

  for (let i = at; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);

    if (pair === "/*" && (nests || depth === 0)) depth++;
    else if (pair === "*/") depth--;
    else continue;
    i++;

    if (depth === 0) return i + 1;
  }

  return -1;
};

const DOLLAR = /^\$([A-Za-z_]\w*)?\$/;

/** What starts at `at` and is skipped whole: a literal, quoted name or comment. -1 when unclosed. */
const skipped = (engine: Engine, text: string, at: number): number | null => {
  const ch = text[at] ?? "";
  const mysql = engine === "mysql";

  if (ch === "'") {
    const escapes = mysql || /(?:^|[^\w$])[Ee]$/.test(text.slice(0, at));

    return quotedEnd(text, at, "'", escapes);
  }

  if (ch === '"') return quotedEnd(text, at, '"', mysql);

  if (ch === "`" && mysql) return quotedEnd(text, at, "`", false);

  if (text.startsWith("/*", at)) return commentEnd(text, at, !mysql);

  if (text.startsWith("--", at) || (ch === "#" && mysql)) {
    const end = text.indexOf("\n", at);

    return end === -1 ? text.length : end;
  }

  const tag = mysql ? null : DOLLAR.exec(text.slice(at))?.[0];

  if (tag === undefined || tag === null) return null;
  const end = text.indexOf(tag, at + tag.length);

  return end === -1 ? -1 : end + tag.length;
};

/**
 * Why a filter can't run inside the Table tab's `WHERE ( … )`, or null when it can: it must keep
 * to one parenthesised expression so ORDER BY, LIMIT and OFFSET always follow it.
 */
export const filterProblem = (engine: Engine, filter: string): string | null => {
  const text = cleanFilter(filter);
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const end = skipped(engine, text, i);

    if (end === -1) return "A quote or /* comment in the filter isn't closed";

    if (end !== null) {
      i = end - 1;
      continue;
    }

    const ch = text[i];

    if (ch === ";") return "The filter is one condition: it can't hold a ; or a second statement";

    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return "The filter closes a parenthesis it didn't open";
  }

  return depth === 0 ? null : "A parenthesis in the filter isn't closed";
};

export interface TableQuery {
  readonly engine: Engine;
  readonly table: TableRef;
  readonly filter: string;
  /** The primary key, so pages don't overlap or skip. */
  readonly orderBy: ReadonlyArray<string>;
  readonly limit: number;
  readonly offset: number;
}

/** One clause a line, the filter on lines of its own: a `--` in it ends before ORDER BY. */
export const tableSql = ({ engine, table, filter, orderBy, limit, offset }: TableQuery) => {
  const where = cleanFilter(filter);
  const parts = [`SELECT * FROM ${qualifiedName(engine, table)}`];

  if (where !== "") parts.push(`WHERE (\n${where}\n)`);

  if (orderBy.length > 0)
    parts.push(`ORDER BY ${orderBy.map((c) => quoteIdent(engine, c)).join(", ")}`);
  parts.push(`LIMIT ${limit}`);

  if (offset > 0) parts.push(`OFFSET ${offset}`);

  return parts.join("\n");
};

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** A key's value as a literal of its type: numbers bare, booleans as words, the rest quoted. */
const literalOf = (engine: Engine, value: DataValue | undefined) => {
  const cell = cellOf(value);
  const raw = cell.raw ?? "";

  if (cell.kind === "bool") return raw === "true" ? "TRUE" : "FALSE";

  return cell.kind === "number" && DECIMAL.test(raw) ? raw : quoteValue(engine, raw);
};

/**
 * The filter a foreign key opens its table with: the referenced column equal to the whole value,
 * typed; or why this value can't be followed (NULL, bytes, a value cut short, a line break).
 */
export const keyFilter = (
  engine: Engine,
  column: string,
  value: DataValue | undefined
): { readonly filter: string } | { readonly reason: string } => {
  const reason = unfollowable(value);

  return reason === null
    ? { filter: `${identFor(engine, column)} = ${literalOf(engine, value)}` }
    : { reason };
};
