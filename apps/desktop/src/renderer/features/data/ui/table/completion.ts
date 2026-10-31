/**
 * The filter well's completion: the table's columns (and a few SQL words) for the identifier
 * being typed at the caret. Columns that start with it come first, then ones that contain it.
 */

export interface Completion {
  readonly label: string;
  /** The column's type, or "keyword". */
  readonly detail: string;
}

export interface Completions {
  /** The range the chosen label replaces. */
  readonly from: number;
  readonly to: number;
  readonly items: ReadonlyArray<Completion>;
}

const KEYWORDS = ["and", "or", "not", "is null", "is not null", "like", "ilike", "in", "between"];

const MAX_ITEMS = 8;

const IDENT = /[A-Za-z_][\w$]*$/;

/** Inside a string literal: an odd number of quotes before the caret. */
const inString = (before: string) => (before.match(/'/g)?.length ?? 0) % 2 === 1;

export const complete = (
  text: string,
  caret: number,
  columns: ReadonlyArray<{ readonly name: string; readonly type: string }>
): Completions | null => {
  const before = text.slice(0, caret);
  const token = IDENT.exec(before)?.[0];

  if (token === undefined || inString(before)) return null;
  const end = caret + (/^[\w$]*/.exec(text.slice(caret))?.[0].length ?? 0);
  const word = token.toLowerCase();

  const rank = (label: string) => {
    const lower = label.toLowerCase();

    if (lower === word) return -1;

    if (lower.startsWith(word)) return 0;

    return lower.includes(word) ? 1 : -1;
  };

  const scored = [
    ...columns.map((c) => ({ label: c.name, detail: c.type })),
    ...KEYWORDS.map((k) => ({ label: k, detail: "keyword" })),
  ].flatMap((item) => {
    const score = rank(item.label);

    return score >= 0 && (item.detail !== "keyword" || score === 0) ? [{ item, score }] : [];
  });

  const items = scored
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_ITEMS)
    .map(({ item }) => item);

  return items.length === 0 ? null : { from: caret - token.length, to: end, items };
};

/** The text with a completion applied, and where the caret goes. */
export const applyCompletion = (text: string, at: Completions, label: string) => {
  const inserted = `${label} `;

  return {
    text: `${text.slice(0, at.from)}${inserted}${text.slice(at.to).replace(/^ /, "")}`,
    caret: at.from + inserted.length,
  };
};
