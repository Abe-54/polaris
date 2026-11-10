/** The log reads of a Daemon start and of the pruning sweep stay on an index (migration 0008). */
import { describe, expect, test } from "bun:test";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { WorktreeId } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { SqlClient, type Statement } from "effect/sql";
import { MigrationsLayer } from "./migrations.ts";
import { graphEventRows, resourceEventRows, worktreeDetectedRows } from "./projection.ts";

const migrated = MigrationsLayer.pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))
);

/** How SQLite reads `events` for the store's own query, on a migrated database. */
const eventsPlan = (query: (sql: SqlClient.SqlClient) => Statement.Fragment) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const steps = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN ${query(sql)}`;

      return steps.map((step) => step.detail).filter((detail) => /\bevents\b/.test(detail));
    }).pipe(Effect.provide(migrated))
  );

interface Read {
  readonly what: string;
  readonly query: (sql: SqlClient.SqlClient) => Statement.Fragment;
  readonly index: string;
}

const reads: ReadonlyArray<Read> = [
  { what: "a start's Resource events", query: resourceEventRows, index: "events_type" },
  { what: "a start's Constellation events", query: graphEventRows, index: "events_graph" },
  {
    what: "a Worktree's last detection",
    query: (sql) => worktreeDetectedRows(sql, WorktreeId.make("wt-1")),
    index: "events_type",
  },
];

describe("event log indexes", () => {
  for (const { what, query, index } of reads) {
    test(`${what} are read through an index, not a scan of the log`, async () => {
      const steps = await eventsPlan(query);
      expect(steps.filter((step) => !step.includes(`events USING INDEX ${index}`))).toEqual([]);
      expect(steps).toHaveLength(1);
    });
  }
});
