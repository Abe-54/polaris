import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  AgentSession,
  BackgroundTask,
  CommandId,
  DomainEvent,
  SessionId,
  Turn,
  TurnId,
  TurnTrigger,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect } from "effect";
import { tempDir } from "../platform/tempDir.testing.ts";
import { EventStore } from "./EventStore.ts";
import { foldSession, patchTurn, type SessionRecord } from "./model.ts";

const at = "2026-11-09T00:00:00.000Z";

const sessionId = SessionId.make("s-1");

const session = new AgentSession({
  id: sessionId,
  workspaceId: WorkspaceId.make("ws-1"),
  harness: "claude",
  title: "t",
  cwd: "/repo",
  worktreeId: null,
  state: "idle",
  permissionMode: "supervised",
  model: null,
  effort: null,
  parentSessionId: null,
  forkedFromTurnId: null,
  harnessCursor: null,
  turnCount: 0,
  contextUsage: null,
  lastError: null,
  createdAt: at,
  updatedAt: at,
});

const turn = (id: string, index: number, harnessStarted = false) =>
  new Turn({
    id: TurnId.make(id),
    sessionId,
    index,
    prompt: `prompt ${id}`,
    trigger: harnessStarted ? TurnTrigger.cases.BackgroundTasksReported.make({ tasks: [] }) : null,
    attachments: [],
    model: null,
    effort: null,
    status: "working",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: at,
    endedAt: null,
  });

const afterRef = (t: Turn) => `refs/polaris/checkpoints/${sessionId}/${t.id}/after`;

const commitOf = (t: Turn) => `${t.id}`.padEnd(40, "0");

const checkpoint = (t: Turn) =>
  DomainEvent.cases.CheckpointRecorded.make({
    sessionId,
    turnId: t.id,
    ref: afterRef(t),
    commit: commitOf(t),
  });

/** A Turn whole, its `TurnEnded` as a Daemon before `checkpointAfterCommit` logged it. */
const run = (t: Turn) => [
  DomainEvent.cases.TurnStarted.make({ turn: t }),
  checkpoint(t),
  DomainEvent.cases.TurnEnded.make({
    turn: patchTurn(t, { status: "completed", endedAt: at, checkpointAfter: afterRef(t) }),
  }),
];

/** `throughUserTurn` null: as a Daemon before it logged the event. */
const accepted = (t: Turn, index: number, throughUserTurn: number | null = null) =>
  DomainEvent.cases.TurnsAccepted.make({
    sessionId,
    throughTurnId: t.id,
    throughIndex: index,
    throughUserTurn,
    revertLaterTurns: false,
    acceptedBy: "test",
  });

const fold = (events: ReadonlyArray<DomainEvent>): SessionRecord =>
  foldSession(
    sessionId,
    undefined,
    [DomainEvent.cases.SessionCreated.make({ session }), ...events],
    at
  )!;

const [u1, c1, u2] = [turn("u1", 0), turn("c1", 1, true), turn("u2", 2)];

describe("checkpointAfterCommit", () => {
  test("a Turn keeps the commit its after-checkpoint recorded, through its TurnEnded", () => {
    const record = fold([...run(u1), ...run(u2)]);

    expect(record.turns.map((t) => t.checkpointAfterCommit)).toEqual([commitOf(u1), commitOf(u2)]);
  });
});

describe("acceptedThroughUserTurn", () => {
  test("is the accepted Turn's user-Turn number, not its index", () => {
    const record = fold([...run(u1), ...run(c1), ...run(u2), accepted(c1, 1)]);

    expect(record.session.acceptedThroughIndex).toBe(1);
    expect(record.session.acceptedThroughUserTurn).toBe(1);
  });

  test("the event's number wins over a Turn the fold no longer holds", () => {
    const record = fold([...run(u1), accepted(turn("gone", 7), 7, 4)]);

    expect(record.session.acceptedThroughUserTurn).toBe(4);
  });
});

describe("backgroundReportsPending", () => {
  const tasksChanged = (reportsPending: boolean) =>
    DomainEvent.cases.SessionBackgroundTasksChanged.make({ sessionId, tasks: [], reportsPending });

  test("holds from the change that says so until the Harness starts a Turn", () => {
    const waiting = fold([...run(u1), tasksChanged(true)]);
    const continued = fold([...run(u1), tasksChanged(true), ...run(c1)]);

    expect(waiting.session.backgroundReportsPending).toBe(true);
    expect(continued.session.backgroundReportsPending).toBe(false);
  });

  test("a change logged before the field had none pending", () => {
    const old = DomainEvent.cases.SessionBackgroundTasksChanged.make({
      sessionId,
      tasks: [new BackgroundTask({ id: "b", kind: "command", description: "Build" })],
    });

    expect(fold([tasksChanged(true), old]).session.backgroundReportsPending).toBe(false);
  });
});

describe("an event log from before these fields", () => {
  test("migrating fills in each Turn's commit and the accepted user Turn", async () => {
    const file = join(tempDir("polaris-turn-fields-"), "state.sqlite");

    const storeAt = <A, E>(program: Effect.Effect<A, E, EventStore>) =>
      Effect.runPromise(program.pipe(Effect.provide(EventStore.layerSqlite(file))));

    await storeAt(
      Effect.flatMap(EventStore, (store) =>
        store.commit({
          commandId: CommandId.make("seed"),
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.SessionCreated.make({ session }),
              ...run(u1),
              ...run(c1),
              ...run(u2),
              accepted(c1, 1),
            ]),
        })
      )
    );

    const db = new Database(file);
    db.run("UPDATE turns SET data = json_remove(data, '$.checkpointAfterCommit')");
    db.run("UPDATE sessions SET data = json_remove(data, '$.acceptedThroughUserTurn')");
    db.run("DELETE FROM effect_sql_migrations WHERE migration_id >= 7");
    db.close();

    const record = await storeAt(
      Effect.map(
        EventStore.use((store) => store.model),
        (m) => m.sessions.get(sessionId)!
      )
    );

    expect(record.turns.map((t) => t.checkpointAfterCommit)).toEqual([
      commitOf(u1),
      commitOf(c1),
      commitOf(u2),
    ]);
    expect(record.session.acceptedThroughUserTurn).toBe(1);
  });
});
