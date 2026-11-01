/**
 * ⌘L's source: rows as Markdown for an Agent Session's draft (where they came from, then a fenced
 * CSV), appended after the draft as Edit's ⌘L appends lines. NULL is written NULL and text "NULL"
 * quoted; a value cut short on the wire says so. The block keeps to the draft's character budget.
 */
import type { GridColumn } from "./columns.ts";
import { csvHeader, csvRow, type CsvOptions } from "./csv.ts";
import { type DataRow, formatSize } from "./value.ts";

export interface RowsSource {
  /** The Data Source's name. */
  readonly source: string;
  /** What the rows are: a table ("public.invoices") or a query's SQL. */
  readonly from: string;
  readonly columns: ReadonlyArray<GridColumn>;
  readonly rows: ReadonlyArray<DataRow>;
}

export interface RowsBlock {
  readonly text: string;
  /** How many of the rows fit the budget: the first `rows`. */
  readonly rows: number;
}

const FOR_AGENT: CsvOptions = {
  nullToken: "NULL",
  cut: (cell) =>
    `${cell.raw ?? ""}…(cut short: ${formatSize(cell.bytes ?? 0, "bytes")} in the database)`,
};

const longestRun = (text: string) => Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));

export const rowsLabel = (n: number) => (n === 1 ? "1 row" : `${n.toLocaleString("en-US")} rows`);

/** "312 rows", or "The first 312 rows of 10,000 selected" when the budget cut the rest. */
const countText = (n: number, total: number) =>
  n === total
    ? rowsLabel(n)
    : `The first ${rowsLabel(n)} of ${total.toLocaleString("en-US")} selected`;

const heading = (source: RowsSource, count: string) => {
  const where = source.from.includes("\n")
    ? source.from.replaceAll(/\s+/g, " ").trim()
    : source.from;

  return `${count} from \`${source.source}\` · \`${where}\`:\n`;
};

/**
 * The block for the rows that fit in `budget` characters, counted row by row before the text is
 * joined, so 10,000 rows cost what the budget does, never the whole CSV.
 */
export const rowsBlock = (source: RowsSource, budget = Number.POSITIVE_INFINITY): RowsBlock => {
  const lines = [csvHeader(source.columns, FOR_AGENT)];
  let fence = Math.max(3, longestRun(lines[0] ?? "") + 1);
  const total = source.rows.length;
  // The heading at its longest (n as wide as the total), "csv" and the block's line breaks.
  const longest = `The first ${rowsLabel(Math.max(2, total))} of ${total.toLocaleString("en-US")} selected`;
  const fixed = heading(source, longest).length + "csv".length + 3;
  let size = fixed + 2 * fence + (lines[0]?.length ?? 0);

  for (const row of source.rows) {
    const line = csvRow(source.columns, row, FOR_AGENT);
    const wider = Math.max(fence, longestRun(line) + 1);

    if (size + line.length + 1 + 2 * (wider - fence) > budget) break;
    size += line.length + 1 + 2 * (wider - fence);
    fence = wider;
    lines.push(line);
  }

  const n = lines.length - 1;
  const ticks = "`".repeat(fence);

  const head = heading(source, countText(n, total));

  return { text: `${head}${ticks}csv\n${lines.join("\n")}\n${ticks}\n`, rows: n };
};

/** The draft with the block after what's already there, a blank line apart. */
export const appendBlock = (draft: string, block: string): string =>
  draft.trim() === "" ? block : `${draft.trimEnd()}\n\n${block}`;

/** How many characters a block may have before `draft` with it passes `limit`. */
export const blockBudget = (draft: string, limit: number) =>
  Math.max(0, limit - (draft.trim() === "" ? 0 : draft.trimEnd().length + 2));
