import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  AgentSession,
  CommandId,
  DomainEvent,
  SessionId,
  SubagentId,
  Turn,
  TurnId,
  TurnItem,
  TurnTrigger,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect } from "effect";
import { tempDir } from "../platform/tempDir.testing.ts";
import { EventStore } from "./EventStore.ts";
import { foldSession, patchTurn, type SessionRecord } from "./model.ts";

const at = "2026-10-19T00:00:00.000Z";

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

const background = TurnTrigger.cases.BackgroundTasksReported.make({ tasks: [] });

/** A Turn as an older Daemon logged it: no user-Turn number, no reply preview. */
const turn = (id: string, index: number, harnessStarted = false) =>
  new Turn({
    id: TurnId.make(id),
    sessionId,
    index,
    prompt: harnessStarted ? "[Background task continuation]" : `prompt ${id}`,
    trigger: harnessStarted ? background : null,
    attachments: [],
    model: null,
    effort: null,
    status: "working",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: `2026-10-19T00:00:0${index}.000Z`,
    endedAt: null,
  });

const started = (t: Turn) => DomainEvent.cases.TurnStarted.make({ turn: t });

const ended = (t: Turn, status: "completed" | "interrupted" = "completed") =>
  DomainEvent.cases.TurnEnded.make({ turn: patchTurn(t, { status, endedAt: at }) });

const reply = (t: Turn, text: string, subagent: string | null = null) =>
  DomainEvent.cases.TurnItemCompleted.make({
    sessionId,
    turnId: t.id,
    item: TurnItem.cases.AssistantMessage.make({ id: `m-${text.length}`, text }),
    subagentId: subagent === null ? null : SubagentId.make(subagent),
  });

/** Each Turn whole: started, its replies, ended. */
const run = (t: Turn, ...replies: ReadonlyArray<string>) => [
  started(t),
  ...replies.map((text) => reply(t, text)),
  ended(t),
];

const fold = (events: ReadonlyArray<DomainEvent>): SessionRecord =>
  foldSession(
    sessionId,
    undefined,
    [DomainEvent.cases.SessionCreated.make({ session }), ...events],
    at
  )!;

const numbers = (record: SessionRecord) => record.turns.map((t) => t.userTurnNumber);

describe("user-Turn numbers", () => {
  test("a Turn the Harness started keeps the number of the user Turn before it", () => {
    const [u1, c1, c2, u2, c3] = [
      turn("u1", 0),
      turn("c1", 1, true),
      turn("c2", 2, true),
      turn("u2", 3),
      turn("c3", 4, true),
    ];

    const record = fold([...run(u1), ...run(c1), ...run(c2), ...run(u2), ...run(c3)]);

    expect(numbers(record)).toEqual([1, 1, 1, 2, 2]);
    expect(record.session.currentUserTurn).toEqual({
      turnId: u2.id,
      number: 2,
      startedAt: u2.startedAt,
    });
  });

  test("a session's first Turn is user Turn 1 even when the Harness started it", () => {
    const [c1, u1] = [turn("c1", 0, true), turn("u1", 1)];
    const afterLeading = fold(run(c1));

    expect(afterLeading.session.currentUserTurn).toEqual({
      turnId: c1.id,
      number: 1,
      startedAt: c1.startedAt,
    });
    expect(numbers(fold([...run(c1), ...run(u1)]))).toEqual([1, 2]);
  });

  test("a continued Turn starts again under its own number", () => {
    const [u1, u2] = [turn("u1", 0), turn("u2", 1)];
    const record = fold([started(u1), ended(u1, "interrupted"), ...run(u1), ...run(u2)]);

    expect(numbers(record)).toEqual([1, 2]);
    expect(record.session.currentUserTurn?.turnId).toBe(u2.id);
  });
});

describe("reply previews", () => {
  test("the Turn's last reply, as plain text, is its preview and the session's", () => {
    const t = turn("u1", 0);

    const record = fold([
      started(t),
      reply(t, "Looking into it."),
      reply(t, "A Subagent's own reply", "sub-1"),
      reply(t, "## Fixed\n\nThe **flaky** test now waits for `ready`."),
      reply(t, "   "),
      ended(t),
      reply(t, "Late, after the Turn ended."),
    ]);

    expect(record.turns[0]!.replyPreview).toBe("Fixed The flaky test now waits for ready.");
    expect(record.session.lastReplyPreview).toBe("Fixed The flaky test now waits for ready.");
  });

  test("a Turn without reply text has none, and the session's follows the latest ended Turn", () => {
    const [u1, u2] = [turn("u1", 0), turn("u2", 1)];
    const midway = fold([...run(u1, "Done."), started(u2)]);

    expect(midway.session.lastReplyPreview).toBe("Done.");

    const record = fold([...run(u1, "Done."), ...run(u2)]);

    expect(record.turns[1]!.replyPreview).toBeNull();
    expect(record.session.lastReplyPreview).toBeNull();
  });
});

describe("an event log from before user Turns", () => {
  test("migrating fills in the numbers and previews its Turns fold to", async () => {
    const file = join(tempDir("polaris-user-turns-"), "state.sqlite");
    const [u1, c1, u2] = [turn("u1", 0), turn("c1", 1, true), turn("u2", 2)];

    const storeAt = <A, E>(program: Effect.Effect<A, E, EventStore>) =>
      Effect.runPromise(program.pipe(Effect.provide(EventStore.layerSqlite(file))));

    await storeAt(
      Effect.flatMap(EventStore, (store) =>
        store.commit({
          commandId: CommandId.make("seed"),
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.SessionCreated.make({ session }),
              ...run(u1, "First *answer*."),
              ...run(c1, "Background done."),
              started(u2),
              reply(u2, "Working on [it](https://x.example)."),
            ]),
        })
      )
    );

    // What an older Daemon left: rows without the derived fields, and migrations 5 on not run.
    const db = new Database(file);
    db.run("UPDATE turns SET data = json_remove(data, '$.userTurnNumber', '$.replyPreview')");
    db.run(
      "UPDATE sessions SET data = json_remove(data, '$.currentUserTurn', '$.lastReplyPreview')"
    );
    // Later migrations go too, or the migrator (which runs ids above the latest) skips 5.
    db.run("DROP TABLE session_reads");
    db.run("DROP TABLE session_drafts");
    db.run("DROP INDEX events_type");
    db.run("DROP INDEX events_graph");
    db.run("DELETE FROM effect_sql_migrations WHERE migration_id >= 5");
    db.close();

    const record = await storeAt(
      Effect.map(
        EventStore.use((store) => store.model),
        (m) => m.sessions.get(sessionId)!
      )
    );

    expect(record.turns.map((t) => [t.userTurnNumber, t.replyPreview])).toEqual([
      [1, "First answer."],
      [1, "Background done."],
      [2, "Working on it."],
    ]);
    expect(record.session.currentUserTurn).toEqual({
      turnId: u2.id,
      number: 2,
      startedAt: u2.startedAt,
    });
    expect(record.session.lastReplyPreview).toBe("Background done.");
  });
});
