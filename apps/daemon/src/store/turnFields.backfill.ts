/**
 * Migration `0007_turn_fields`: `Turn.checkpointAfterCommit` from the log's `CheckpointRecorded`
 * events, for Turns already logged.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

interface CheckpointRow {
  readonly turn_id: string;
  readonly ref: string;
  readonly commit_sha: string;
}

export const backfillTurnFields = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const checkpoints = yield* sql<CheckpointRow>`
    SELECT json_extract(payload, '$.turnId') AS turn_id,
      json_extract(payload, '$.ref') AS ref,
      json_extract(payload, '$.commit') AS commit_sha
    FROM events
    WHERE event_type = 'CheckpointRecorded' AND json_extract(payload, '$.ref') LIKE '%/after'
    ORDER BY sequence`;

  // A later checkpoint of the same Turn overwrites an earlier one, as the fold does.
  for (const row of checkpoints)
    yield* sql`UPDATE turns SET data = json_set(data, '$.checkpointAfterCommit', ${row.commit_sha})
      WHERE id = ${row.turn_id} AND json_extract(data, '$.checkpointAfter') = ${row.ref}`;
});
