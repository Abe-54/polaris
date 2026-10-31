/**
 * SQL split into coloured runs for a card's read-only statement: keywords, strings, numbers,
 * comments and punctuation, by `maskLiterals`' spans so a keyword inside a literal stays a literal.
 */
import { maskLiterals } from "../sql/literals.ts";

export type SqlTokenKind = "keyword" | "string" | "number" | "comment" | "punctuation" | "plain";

export interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly text: string;
}

const KEYWORDS = new Set(
  (
    "select from where update set insert into values delete returning join left right inner outer " +
    "full cross on using and or not null is in as with group by order having limit offset distinct " +
    "case when then else end create alter drop table index add column constraint primary key " +
    "foreign references default unique truncate replace merge upsert conflict do nothing exists " +
    "between like ilike true false asc desc union all interval cascade"
  ).split(" ")
);

const WORD = /[A-Za-z_][\w$]*|\d+(?:\.\d+)?|"[^"]*"|`[^`]*`|\s+|[^\w\s]/y;

const kindOf = (word: string): SqlTokenKind => {
  if (/^\d/.test(word)) return "number";

  if (/^[^\w\s"`]$/.test(word)) return "punctuation";

  return KEYWORDS.has(word.toLowerCase()) ? "keyword" : "plain";
};

const push = (tokens: Array<SqlToken>, kind: SqlTokenKind, text: string) => {
  const last = tokens.at(-1);

  if (last?.kind === kind) tokens[tokens.length - 1] = { kind, text: last.text + text };
  else tokens.push({ kind, text });
};

/** The statement as runs that join back to it exactly. */
export const sqlTokens = (sql: string): ReadonlyArray<SqlToken> => {
  // Spaces stand in as \u0001 first, so only a literal's or comment's characters mask to " ".
  const masked = maskLiterals(sql.replace(/[^\S\n]/g, "\u0001"));
  const inLiteral = (at: number) => masked[at] === " ";
  const tokens: Array<SqlToken> = [];
  let i = 0;

  while (i < sql.length) {
    if (inLiteral(i)) {
      let end = i;

      while (end < sql.length && inLiteral(end)) end++;
      const text = sql.slice(i, end);

      push(tokens, /^\s*(--|\/\*)/.test(text) ? "comment" : "string", text);
      i = end;
      continue;
    }

    WORD.lastIndex = i;
    const word = WORD.exec(sql)?.[0] ?? sql[i] ?? "";
    const text = sql.slice(i, i + word.length);

    push(tokens, /^\s+$/.test(text) ? "plain" : kindOf(text), text);
    i += Math.max(1, word.length);
  }

  return tokens;
};
