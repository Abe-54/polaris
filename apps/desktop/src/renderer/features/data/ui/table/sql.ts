/**
 * The Table tab's Query: `SELECT * FROM t [WHERE …] [ORDER BY key] LIMIT n [OFFSET m]`, quoted for
 * the Data Source's engine. The filter is the user's own SQL; the Daemon runs it read-only.
 */
import type { DataSource } from "@polaris/protocol";

export type Engine = DataSource["engine"];

export const quoteIdent = (engine: Engine, name: string) =>
  engine === "mysql" ? `\`${name.replaceAll("`", "``")}\`` : `"${name.replaceAll('"', '""')}"`;

/** A string literal; MySQL also reads backslash escapes inside quotes, so those double too. */
export const quoteValue = (engine: Engine, raw: string) => {
  const escaped = engine === "mysql" ? raw.replaceAll("\\", "\\\\") : raw;

  return `'${escaped.replaceAll("'", "''")}'`;
};

/** The filter as typed, without a leading WHERE or trailing semicolons. */
export const cleanFilter = (filter: string) =>
  filter
    .trim()
    .replace(/^where\s+/i, "")
    .replace(/[;\s]+$/, "");

export interface TableQuery {
  readonly engine: Engine;
  readonly table: string;
  readonly filter: string;
  /** The primary key, so pages don't overlap or skip. */
  readonly orderBy: ReadonlyArray<string>;
  readonly limit: number;
  readonly offset: number;
}

export const tableSql = ({ engine, table, filter, orderBy, limit, offset }: TableQuery) => {
  const where = cleanFilter(filter);
  const parts = [`SELECT * FROM ${quoteIdent(engine, table)}`];

  if (where !== "") parts.push(`WHERE ${where}`);

  if (orderBy.length > 0)
    parts.push(`ORDER BY ${orderBy.map((c) => quoteIdent(engine, c)).join(", ")}`);
  parts.push(`LIMIT ${limit}`);

  if (offset > 0) parts.push(`OFFSET ${offset}`);

  return parts.join(" ");
};

/** The filter a foreign key opens its table with: the referenced column equal to the value. */
export const keyFilter = (engine: Engine, column: string, raw: string) =>
  `${quoteIdent(engine, column)} = ${quoteValue(engine, raw)}`;
