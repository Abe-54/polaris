/** Credential bindings are scrubbed before the approval is persisted, using the server's lexical mode. */
import { scrubDataValue, type DataValue } from "@polaris/protocol";
import { Match, type Redacted } from "effect";
import type { LexicalMode } from "./guard.ts";
import { sqlTokens, topLevel, type writePlan } from "./writeSql.ts";

export const credentialColumn = (name: string) =>
  /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential/i.test(name);

type Tokens = ReturnType<typeof sqlTokens>;

function assignmentRanges(plan: ReturnType<typeof writePlan>, mode: LexicalMode) {
  const top = topLevel(sqlTokens(plan.sql, mode));
  const set = top.findIndex((token) => token.word === "SET");
  const end = top.findIndex((token) => token.word === "WHERE");
  const assignments = top.slice(set + 1, end < 0 ? undefined : end);
  const ranges: Array<{ start: number; end: number }> = [];
  let beginning = true;

  for (let i = 0; i < assignments.length; i++) {
    const token = assignments[i]!;

    if (beginning && credentialColumn(token.raw)) {
      const next = assignments.slice(i + 1).find((value) => value.word === ",");
      ranges.push({ start: token.start, end: next?.start ?? plan.whereOffset });
    }

    beginning = token.word === ",";
  }

  return ranges;
}

function parameterIndexes(tokens: Tokens, engine: LexicalMode["engine"]) {
  let position = 0;

  return tokens.flatMap((token, i) => {
    if (engine === "mysql" && token.word === "?") return [{ ...token, index: position++ }];

    if (engine === "postgres" && token.raw === "$" && /^\d+$/.test(tokens[i + 1]?.raw ?? ""))
      return [{ ...token, index: Number(tokens[i + 1]!.raw) - 1 }];

    return [];
  });
}

function insertRanges(plan: ReturnType<typeof writePlan>, mode: LexicalMode) {
  const tokens = sqlTokens(plan.sql.slice(plan.targetEnd), mode);

  if (tokens[0]?.word !== "(") return undefined;
  const end = tokens.findIndex((token) => token.word === ")");
  const columns = tokens.slice(1, end).filter((token) => token.word !== ",");

  if (tokens[end + 1]?.word !== "VALUES") return undefined;
  let depth = 0;
  let column = 0;
  let start = 0;
  const ranges: Array<{ start: number; end: number }> = [];

  const addRange = (end: number) => {
    if (credentialColumn(columns[column]?.raw ?? ""))
      ranges.push({ start: start + plan.targetEnd, end: end + plan.targetEnd });
  };

  for (const token of tokens.slice(end + 2)) {
    if (token.word === "(" && depth++ === 0) {
      column = 0;
      start = token.end;
    } else if (token.word === ")") {
      depth--;

      if (depth === 0) addRange(token.start);
    } else if (token.word === "," && depth === 1) {
      addRange(token.start);
      column++;
      start = token.end;
    }
  }

  return ranges;
}

export function writeParams(
  plan: ReturnType<typeof writePlan>,
  mode: LexicalMode,
  params: ReadonlyArray<DataValue>,
  known: ReadonlyArray<Redacted.Redacted<string>>
) {
  const tokens = sqlTokens(plan.sql, mode);
  const sensitive = new Set<number>();

  const ranges = Match.value(plan.keyword).pipe(
    Match.when("UPDATE", () => assignmentRanges(plan, mode)),
    Match.when("INSERT", () => insertRanges(plan, mode)),
    Match.orElse(() => [])
  );

  for (const token of parameterIndexes(tokens, mode.engine))
    if (
      ranges === undefined ||
      ranges.some((range) => token.start >= range.start && token.start < range.end)
    )
      sensitive.add(token.index);

  return params.map((value, i) => (sensitive.has(i) ? "[redacted]" : scrubDataValue(value, known)));
}
