/** Conservative write targets; lexical boundaries are shared with read-only Queries. */
import { DataError, type DataSource } from "@polaris/protocol";
import { guardSql, tokenAt, type LexicalMode } from "./guard.ts";

export const writeError = (message: string, fix = "Check the statement and preview it again.") =>
  new DataError({ code: "E-DATA-SQL", message, fix });

export const identifier = (name: string, engine: DataSource["engine"]) => {
  const quote = engine === "postgres" ? '"' : "`";

  return quote + name.replaceAll(quote, quote + quote) + quote;
};

export function sqlTokens(sql: string, mode: LexicalMode) {
  const result: Array<{ word: string; raw: string; start: number; end: number }> = [];

  for (let i = 0; i < sql.length;) {
    const token = tokenAt(sql, i, mode);

    if (token.token !== undefined)
      result.push({ word: token.token, raw: sql.slice(i, token.end), start: i, end: token.end });
    i = token.end;
  }

  return result;
}

function name(raw: string | undefined, engine: DataSource["engine"]) {
  if (raw === undefined) throw writeError("Name the table to change.");
  const quote = engine === "postgres" ? '"' : "`";

  if (raw.startsWith(quote) && raw.endsWith(quote))
    return raw.slice(1, -1).replaceAll(quote + quote, quote);

  if (!/^[a-z_][a-z0-9_$]*$/i.test(raw)) throw writeError("This write target cannot be previewed.");

  return engine === "postgres" ? raw.toLowerCase() : raw;
}

function ddlAllowed(source: DataSource) {
  if (source.locality !== "local")
    throw writeError(
      "DDL is only available on local data sources.",
      "Run the migration with your project's tool."
    );

  if (source.engine === "mysql")
    throw writeError(
      "MySQL commits DDL implicitly, so Polaris can't dry-run it.",
      "Run the migration with your project's tool."
    );
}

function explicitTarget(
  tokens: ReturnType<typeof sqlTokens>,
  keyword: string,
  engine: DataSource["engine"]
) {
  let index = keyword === "UPDATE" ? 1 : 2;

  if (keyword !== "UPDATE" && tokens[1]?.word !== (keyword === "DELETE" ? "FROM" : "INTO"))
    throw writeError("Use an explicit single-table write.");
  const start = tokens[index]?.start ?? 0;
  const first = name(tokens[index++]?.raw, engine);
  let schema: string | undefined;
  let table = first;

  if (tokens[index]?.word === ".") {
    schema = first;
    table = name(tokens[index + 1]?.raw, engine);
    index += 2;
  }

  const next = tokens[index]?.word;

  if (keyword === "UPDATE" && next !== "SET")
    throw writeError(
      "UPDATE aliases cannot be previewed.",
      "Use the explicit table name without an alias."
    );

  if (keyword === "DELETE" && next !== undefined && next !== "WHERE")
    throw writeError(
      "DELETE aliases or multi-table targets cannot be previewed.",
      "Rewrite with a read-only subquery, or use your project's migration tool."
    );

  if (keyword === "INSERT" && next === "AS")
    throw writeError(
      "INSERT aliases cannot be previewed.",
      "Use the explicit table name without an alias."
    );

  return {
    target: { ...(schema === undefined ? undefined : { schema }), table },
    targetStart: start,
    targetEnd: tokens[index - 1]!.end,
  };
}

export function topLevel(tokens: ReturnType<typeof sqlTokens>) {
  let depth = 0;

  return tokens.filter((token) => {
    if (["(", "["].includes(token.word)) {
      depth++;

      return false;
    }

    if ([")", "]"].includes(token.word)) {
      depth--;

      return false;
    }

    return depth === 0;
  });
}

export function refuseCommaJoins(sql: string, mode: LexicalMode) {
  let depth = 0;
  const from = new Set<number>();

  for (const token of sqlTokens(sql, mode)) {
    if (token.word === "(") depth++;

    if (token.word === ")") {
      from.delete(depth);
      depth--;
    }

    if (token.word === "FROM") from.add(depth);

    if (
      [
        "WHERE",
        "GROUP",
        "HAVING",
        "ORDER",
        "UNION",
        "EXCEPT",
        "INTERSECT",
        "SET",
        "VALUES",
        ";",
      ].includes(token.word)
    )
      from.delete(depth);

    if (token.word === "," && from.has(depth))
      throw writeError(
        "Comma-separated joins cannot be previewed.",
        "Use a single explicit table or the app's own code."
      );
  }
}

export function writePlan(sql: string, source: DataSource, mode: LexicalMode) {
  const checked = guardSql(sql, mode, true);
  const tokens = sqlTokens(checked.sql, mode);
  const ddl = ["CREATE", "ALTER", "DROP", "TRUNCATE", "COMMENT"].includes(checked.keyword);

  if (ddl) {
    ddlAllowed(source);

    return {
      ...checked,
      ddl,
      target: undefined,
      targetStart: 0,
      targetEnd: 0,
      where: "",
      whereOffset: 0,
    };
  }

  if (!["INSERT", "UPDATE", "DELETE"].includes(checked.keyword))
    throw writeError(
      "This statement cannot be safely previewed.",
      "Use a single INSERT, UPDATE or DELETE, or your project's migration tool."
    );
  const target = explicitTarget(tokens, checked.keyword, source.engine);
  refuseCommaJoins(checked.sql, mode);

  if (tokens.some((t) => ["RETURNING", "JOIN", "USING", "LIMIT", "ORDER", "WITH"].includes(t.word)))
    throw writeError(
      "This write form cannot be safely previewed.",
      "Rewrite joins, aliases, CTEs, RETURNING and ORDER/LIMIT with a read-only subquery, or use your project's migration tool."
    );

  if (
    tokens.some(
      (t, i) => t.word === "ON" && ["CONFLICT", "DUPLICATE"].includes(tokens[i + 1]?.word ?? "")
    )
  )
    throw writeError(
      "Upserts cannot be previewed.",
      "Use separate INSERT or UPDATE statements; upserts are tracked in ENG-669."
    );

  if (source.engine === "mysql")
    for (let i = 0; i < tokens.length; i++) {
      if (
        ["FROM", "INTO", "UPDATE", "JOIN"].includes(tokens[i]!.word) &&
        tokens[i + 2]?.word === "." &&
        name(tokens[i + 1]?.raw, source.engine) !== source.database
      )
        throw writeError(
          "The statement names a different database.",
          "Select that database as a data source and request approval there."
        );
    }

  const top = topLevel(tokens);

  if (checked.keyword === "UPDATE" && top.some((token) => token.word === "FROM"))
    throw writeError(
      "UPDATE FROM cannot be previewed.",
      "Rewrite the join with a read-only subquery, or use your project's migration tool."
    );
  const where = top.find((t) => t.word === "WHERE");

  return {
    ...checked,
    ddl,
    ...target,
    where: where ? checked.sql.slice(where.start) : "",
    whereOffset: where?.start ?? checked.sql.length,
  };
}

export function updatedColumns(sql: string, mode: LexicalMode) {
  const tokens = topLevel(sqlTokens(sql, mode));
  const start = tokens.findIndex((token) => token.word === "SET");
  const where = tokens.findIndex((token) => token.word === "WHERE");
  const assignments = tokens.slice(start + 1, where < 0 ? undefined : where);
  const columns: string[] = [];
  let beginning = true;

  for (let i = 0; i < assignments.length; i++) {
    const token = assignments[i]!;

    if (beginning) {
      if (assignments[i + 1]?.word !== "=")
        throw writeError(
          "This UPDATE assignment cannot be previewed.",
          "Assign columns individually, without a tuple or alias."
        );
      columns.push(name(token.raw, mode.engine));
      beginning = false;
    }

    if (token.word === ",") beginning = true;
  }

  return columns;
}
