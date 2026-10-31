/** Bound write-card display data without losing redacted change facts. */
import { dataJsonBytes, scrubCredentials, scrubDataValue, type DataValue } from "@polaris/protocol";
import { knownCredentials } from "./execution.ts";
import type { Column, RawResult } from "./values.ts";
import type { WriteInput } from "./writeExecution.ts";
import { credentialColumn } from "./writeRedaction.ts";

export function cappedPreview(
  before: { columns: ReadonlyArray<Column>; rows: DataValue[][]; raw?: RawResult | undefined },
  after: DataValue[][],
  input: WriteInput,
  changes?: ReadonlyArray<ReadonlyArray<boolean>>
) {
  const columns = before.columns
    .slice(0, 256)
    .map((c) => scrubCredentials(c.name, knownCredentials(input.connection)).slice(0, 256));

  const previewBefore: DataValue[][] = [];
  const previewAfter: DataValue[][] = [];
  const redactedCells: Array<{ row: number; column: number; changed: boolean }> = [];
  let bytes = dataJsonBytes(columns);

  const scrub = (row: DataValue[]) =>
    row
      .slice(0, 256)
      .map((value, i) =>
        credentialColumn(before.columns[i]?.name ?? "")
          ? "[redacted]"
          : scrubDataValue(value, knownCredentials(input.connection))
      );

  for (let i = 0; i < Math.max(before.rows.length, after.length); i++) {
    const left = before.rows[i] ? scrub(before.rows[i]!) : undefined;
    const right = after[i] ? scrub(after[i]!) : undefined;

    const cells = columns.flatMap((_, column) =>
      credentialColumn(before.columns[column]!.name)
        ? [
            {
              row: i,
              column,
              changed:
                changes?.[i]?.[column] ??
                JSON.stringify(before.rows[i]?.[column]) !== JSON.stringify(after[i]?.[column]),
            },
          ]
        : []
    );

    bytes += dataJsonBytes(left ?? []) + dataJsonBytes(right ?? []) + dataJsonBytes(cells);

    if (bytes > 16000) break;

    if (left) previewBefore.push(left);

    if (right) previewAfter.push(right);

    redactedCells.push(...cells);
  }

  return {
    columns,
    before: previewBefore,
    after: previewAfter,
    redactedCells,
    truncated:
      before.columns.length > columns.length ||
      previewBefore.length < before.rows.length ||
      previewAfter.length < after.length,
  };
}
