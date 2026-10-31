/**
 * "Copy as CSV" (RFC 4180): a header line, then each row. NULL is the NULL token (empty by
 * default) and goes out bare; text equal to it, such as '', is quoted, as Postgres `COPY … CSV` does.
 */
import type { GridColumn } from "./columns.ts";
import { type Cell, cellOf, type DataRow } from "./value.ts";

export interface CsvOptions {
  /** How NULL is written: "" by default; ⌘L's block for an agent writes NULL. */
  readonly nullToken?: string;
  /** Prefix `'` to text a spreadsheet would run as a formula; ⌘L's block stays raw. */
  readonly neutralise?: boolean;
  /** The text a value cut short on the wire is written as; its preview by default. */
  readonly cut?: (cell: Cell) => string;
}

/** What Excel, Numbers and Sheets evaluate on paste or open (OWASP's CSV injection list). */
const FORMULA = /^[=+\-@\t\r]/;

const QUOTED = /[",\r\n]/;

const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;

const field = (text: string, nullToken: string) =>
  text === nullToken || QUOTED.test(text) ? quote(text) : text;

const cellText = (cell: Cell, options: CsvOptions) => {
  const text =
    cell.kind === "cut" && options.cut !== undefined ? options.cut(cell) : (cell.raw ?? "");

  return options.neutralise === true && cell.kind !== "number" && FORMULA.test(text)
    ? `'${text}`
    : text;
};

/** One row as a CSV line, without its line ending. */
export const csvLine = (values: ReadonlyArray<Cell>, options: CsvOptions = {}) => {
  const nullToken = options.nullToken ?? "";

  return values
    .map((cell) => (cell.raw === null ? nullToken : field(cellText(cell, options), nullToken)))
    .join(",");
};

export const csvHeader = (columns: ReadonlyArray<GridColumn>, options: CsvOptions = {}) =>
  csvLine(
    columns.map((c) => ({ kind: "text", raw: c.name })),
    options
  );

export const csvRow = (
  columns: ReadonlyArray<GridColumn>,
  row: DataRow,
  options: CsvOptions = {}
) =>
  csvLine(
    columns.map((_, at) => cellOf(row[at])),
    options
  );

/** Copy as CSV: formulas neutralised, NULL empty and '' quoted unless told otherwise. */
export const toCsv = (
  columns: ReadonlyArray<GridColumn>,
  rows: Iterable<DataRow>,
  options: CsvOptions = { neutralise: true }
): string => {
  const lines = [csvHeader(columns, options)];

  for (const row of rows) lines.push(csvRow(columns, row, options));

  return `${lines.join("\r\n")}\r\n`;
};
