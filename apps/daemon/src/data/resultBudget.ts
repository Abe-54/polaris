/** Bound values before the driver allocates them, including a conservative JSON/metadata allowance. */
import { Schema } from "effect";
import { Column, type RawResult } from "./values.ts";

export const READ_BYTES = 1024 * 1024;

const decodeColumns = Schema.decodeUnknownSync(Schema.Array(Column));

export function budgetProjection(
  sql: string,
  rawColumns: ReadonlyArray<Column>,
  engine: "postgres" | "mysql",
  limit: number
) {
  const all = decodeColumns(rawColumns);
  const columns = all.slice(0, 256);
  const cap = Math.min(32768, Math.floor(131072 / Math.max(columns.length, 1)));
  const names = all.map((_, i) => `c${i}`);

  const text = (name: string) =>
    engine === "postgres" ? `${name}::text` : `CAST(${name} AS BINARY)`;

  const size = (name: string) => `OCTET_LENGTH(${text(name)})`;

  const projection = columns.flatMap((_, i) => {
    const name = names[i]!;

    return [
      `CASE WHEN ${size(name)} <= ${cap} THEN ${name} ELSE NULL END AS v${i}`,
      `CAST(CASE WHEN ${size(name)} > ${cap} THEN ${size(name)} ELSE 0 END AS ${engine === "postgres" ? "text" : "CHAR"}) AS n${i}`,
      `CASE WHEN ${size(name)} > ${cap} THEN LEFT(${text(name)},128) ELSE NULL END AS p${i}`,
    ];
  });

  const cost =
    columns
      .map(
        (_, i) =>
          `(CASE WHEN ${size(names[i]!)} > ${cap} THEN 640 ELSE COALESCE(${size(names[i]!)},0)+32 END)`
      )
      .join("+") || "1";

  const input = `SELECT * FROM (\n${sql}\n) AS polaris_original(${names.join(",")}) LIMIT ${limit}`;
  const materialized = engine === "postgres" ? "MATERIALIZED " : "";

  const bounded = `WITH polaris_input AS ${materialized}(${input})
    SELECT ${projection.join(",")},CAST(polaris_total AS ${engine === "postgres" ? "text" : "CHAR"}) AS polaris_total
    FROM (SELECT *,SUM(${cost}) OVER (ROWS UNBOUNDED PRECEDING) AS polaris_used,
      SUM(${cost}) OVER () AS polaris_total FROM polaris_input) AS polaris_budget
    WHERE polaris_used <= ${READ_BYTES}`;

  return { sql: bounded, columns, tooWide: all.length > columns.length };
}

export function unpackBudget(
  result: RawResult,
  columns: ReadonlyArray<Column>,
  tooWide: boolean
): RawResult {
  const rows: RawResult = Object.assign([], {
    columns,
    truncated: tooWide,
    clipped: new Map<string, { preview: string; bytes: number }>(),
  });

  for (const row of result) {
    const cells = columns.map((_, i) => {
      const size = Number(Buffer.from(row[i * 3 + 1] ?? []).toString());

      if (size > 0)
        rows.clipped!.set(`${rows.length}:${i}`, {
          preview: Buffer.from(row[i * 3 + 2] ?? []).toString(),
          bytes: size,
        });

      return row[i * 3] ?? null;
    });

    if (Number(Buffer.from(row[columns.length * 3] ?? []).toString()) > READ_BYTES)
      rows.truncated = true;
    rows.push(cells);
  }

  rows.truncated ||= rows.clipped!.size > 0;

  return rows;
}
