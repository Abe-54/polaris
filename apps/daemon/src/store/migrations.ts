/**
 * Schema of the Daemon's SQLite database (`~/.polaris/state.sqlite`).
 *
 * `events` is the source of truth: a global, gapless `sequence` per Host.
 * Every other table is a projection of it (or a command receipt), written in
 * the same transaction as the events that change it.
 *
 * Projection rows keep the encoded domain object as JSON next to the columns
 * we filter on, so the read model loads without re-deriving it from events.
 */
import { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { backfillTurnFields } from "./turnFields.backfill.ts";
import { backfillUserTurns } from "./userTurns.backfill.ts";

const init = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY,
      stream_kind TEXT NOT NULL CHECK (stream_kind IN ('host', 'session')),
      session_id TEXT,
      event_type TEXT NOT NULL,
      command_id TEXT,
      occurred_at TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX events_session ON events (session_id, sequence)`;
  yield* sql`
    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY,
      sequence INTEGER,
      rejection TEXT,
      recorded_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      state TEXT NOT NULL,
      title_locked INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX turns_session ON turns (session_id, turn_index)`;
  yield* sql`
    CREATE TABLE turn_items (
      sequence INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX turn_items_turn ON turn_items (turn_id, sequence)`;
  yield* sql`
    CREATE TABLE pending_approvals (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `;
});

/** Subagents (ENG-204): their records, and which items are theirs. */
const subagents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE turn_items ADD COLUMN subagent_id TEXT`;
  yield* sql`
    CREATE TABLE subagents (
      id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    )
  `;
  yield* sql`CREATE INDEX subagents_turn ON subagents (turn_id)`;
});

/** Review (M2): open Review Checkouts, Risk Summaries and Verdicts (`review.ts`). */
const review = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE review_checkouts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE risk_summaries (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      merge_base TEXT NOT NULL,
      head TEXT NOT NULL,
      since TEXT,
      started_sequence INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX risk_summaries_key ON risk_summaries (repo, merge_base, head)`;
  yield* sql`
    CREATE TABLE verdicts (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      summary_id TEXT NOT NULL,
      identity TEXT NOT NULL,
      recorded_sequence INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX verdicts_repo ON verdicts (repo, recorded_sequence)`;
  yield* sql`CREATE INDEX verdicts_summary ON verdicts (summary_id)`;
  yield* sql`CREATE INDEX verdicts_identity ON verdicts (identity)`;
});

const constellations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE events ADD COLUMN constellation_id TEXT`;
  yield* sql`UPDATE events SET constellation_id = json_extract(payload, '$.constellationId') WHERE json_type(payload, '$.constellationId') = 'text'`;
  yield* sql`CREATE INDEX events_constellation ON events (constellation_id, sequence)`;
});

/**
 * Continuity (`continuity.ts`): read positions and drafts, outside the event log. Sessions
 * already logged start read through their last ended Turn, so an upgrade marks nothing unread.
 */
const continuity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE session_reads (
      session_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE session_drafts (
      session_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      revision INTEGER NOT NULL,
      at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO session_reads (session_id, turn_id, turn_index, at)
    SELECT session_id, id, turn_index, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM turns AS t
    WHERE status != 'working' AND turn_index = (
      SELECT MAX(turn_index) FROM turns WHERE session_id = t.session_id AND status != 'working'
    )
  `;
});

export const migrations = SqliteMigrator.fromRecord({
  "0001_event_store": init,
  "0002_subagents": subagents,
  "0003_review": review,
  "0004_constellations": constellations,
  /** `session.user-turns`: the user-Turn numbers and reply previews of Turns already logged. */
  "0005_user_turns": backfillUserTurns,
  "0006_continuity": continuity,
  /** `Turn.checkpointAfterCommit` for Turns already logged. */
  "0007_turn_fields": backfillTurnFields,
});

export const MigrationsLayer = SqliteMigrator.layer({ loader: migrations });
