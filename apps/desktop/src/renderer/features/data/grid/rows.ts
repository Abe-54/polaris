/**
 * ⌘L's source: rows as Markdown for an Agent Session's draft (where they came from, then a fenced
 * CSV), appended after the draft as Edit's ⌘L appends lines.
 */
import type { GridColumn } from "./columns.ts";
import { toCsv } from "./csv.ts";
import { type DataRow } from "./value.ts";

export interface RowsSource {
  /** The Data Source's name. */
  readonly source: string;
  /** What the rows are: a table ("public.invoices") or a query's SQL. */
  readonly from: string;
  readonly columns: ReadonlyArray<GridColumn>;
  readonly rows: ReadonlyArray<DataRow>;
}

const longestRun = (text: string) => Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));

export const rowsLabel = (n: number) => (n === 1 ? "1 row" : `${n.toLocaleString("en-US")} rows`);

export const rowsBlock = ({ source, from, columns, rows }: RowsSource): string => {
  const csv = toCsv(columns, rows).replaceAll("\r\n", "\n");
  const fence = "`".repeat(Math.max(3, longestRun(csv) + 1));
  const where = from.includes("\n") ? from.replaceAll(/\s+/g, " ").trim() : from;

  return `${rowsLabel(rows.length)} from \`${source}\` · \`${where}\`:\n${fence}csv\n${csv}${fence}\n`;
};

/** The draft with the block after what's already there, a blank line apart. */
export const appendBlock = (draft: string, block: string): string =>
  draft.trim() === "" ? block : `${draft.trimEnd()}\n\n${block}`;
