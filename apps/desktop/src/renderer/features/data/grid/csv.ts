/** "Copy as CSV" (RFC 4180): a header line, then each row; NULL is an empty field. */
import type { GridColumn } from "./columns.ts";
import { cellOf, type DataRow } from "./value.ts";

const field = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

export const toCsv = (columns: ReadonlyArray<GridColumn>, rows: Iterable<DataRow>): string => {
  const lines = [columns.map((c) => field(c.name)).join(",")];

  for (const row of rows)
    lines.push(columns.map((_, at) => field(cellOf(row[at]).raw ?? "")).join(","));

  return `${lines.join("\r\n")}\r\n`;
};
