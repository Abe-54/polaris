import {
  DataValueTags,
  QueryDataStreamItem,
  DATA_CHUNK_BYTES,
  dataJsonBytes,
  type DataValue,
} from "@polaris/protocol";
import { Predicate } from "effect";

/** A single wide row must also fit the frame, even when every individual cell fits. */
export function fitRow(row: ReadonlyArray<DataValue>) {
  if (dataJsonBytes([...row]) < DATA_CHUNK_BYTES - 128) return { row: [...row], truncated: false };
  const budget = Math.floor((DATA_CHUNK_BYTES - 1024) / Math.max(row.length, 1));

  return {
    row: row.map((value) => {
      if (dataJsonBytes(value) < budget) return value;
      const text = Predicate.isString(value) ? value : JSON.stringify(value);

      return DataValueTags.cases.Truncated.make({
        preview: text.slice(0, Math.floor((budget - 128) / 6)),
        bytes: dataJsonBytes(value),
      });
    }),
    truncated: true,
  };
}

export function resultChunks(result: {
  queryId: string;
  columns: ReadonlyArray<{ name: string; type: string }>;
  rows: ReadonlyArray<ReadonlyArray<DataValue>>;
  truncated: boolean;
  elapsedMs: number;
}) {
  const items: QueryDataStreamItem[] = [
    QueryDataStreamItem.cases.Header.make({ queryId: result.queryId, columns: result.columns }),
  ];

  let batch: DataValue[][] = [];
  let size = 32;
  let truncated = result.truncated;

  for (const row of result.rows) {
    const fitted = fitRow(row);
    truncated ||= fitted.truncated;
    const bytes = dataJsonBytes(fitted.row) + 1;

    if (batch.length && (batch.length === 500 || size + bytes > DATA_CHUNK_BYTES - 64)) {
      items.push(QueryDataStreamItem.cases.Rows.make({ rows: batch }));
      batch = [];
      size = 32;
    }

    batch.push(fitted.row);
    size += bytes;
  }

  if (batch.length) items.push(QueryDataStreamItem.cases.Rows.make({ rows: batch }));
  items.push(
    QueryDataStreamItem.cases.End.make({
      returned: result.rows.length,
      truncated,
      elapsedMs: result.elapsedMs,
    })
  );

  return items;
}
