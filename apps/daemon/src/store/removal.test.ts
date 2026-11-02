/**
 * `WorkspaceRemoved` purges the Workspace, its Agent Sessions and its Constellations from the
 * read model and every projection table, keeps every event in the log, and a replay of the log
 * (or a restart that loads the tables) reaches the same purged state (docs/adr/0086).
 */
import { tempDir } from "../platform/tempDir.testing.ts";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  AgentSession,
  ApprovalRequest,
  CommandId,
  Constellation,
  ConstellationId,
  ConstellationSettings,
  DomainEvent,
  HostId,
  RequestId,
  SessionId,
  Turn,
  TurnId,
  TurnItem,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect } from "effect";
import { EventStore } from "./EventStore.ts";
import { emptyModel, project, type ReadModel } from "./model.ts";

const at = "2026-10-29T00:00:00.000Z";

const GONE = WorkspaceId.make("ws-gone");

const KEPT = WorkspaceId.make("ws-kept");

const workspace = (id: WorkspaceId) =>
  new Workspace({
    id,
    path: `/code/${id}`,
    name: id,
    isGitRepo: false,
    worktreeRoot: `/code/${id}.worktrees`,
    hidden: true,
    registeredAt: at,
  });

const session = (id: string, workspaceId: WorkspaceId) =>
  new AgentSession({
    id: SessionId.make(id),
    workspaceId,
    harness: "claude",
    title: id,
    cwd: `/code/${workspaceId}`,
    worktreeId: null,
    state: "archived",
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

const constellation = (id: string, workspaceId: WorkspaceId, lead: SessionId) =>
  DomainEvent.cases.ConstellationStarted.make({
    constellationId: ConstellationId.make(id),
    revision: 0,
    constellation: new Constellation({
      id: ConstellationId.make(id),
      hostId: HostId.make("host"),
      workspaceId,
      leadSessionId: lead,
      name: id,
      state: "completed",
      revision: 0,
      settings: ConstellationSettings.make({}),
      tasks: [],
      attempts: [],
      pendingNotifications: [],
      createdAt: at,
      updatedAt: at,
    }),
  });

/** A session with one ended Turn, a reply, a pending approval and a draft row. */
const sessionEvents = (id: string, workspaceId: WorkspaceId) => {
  const created = session(id, workspaceId);
  const turnId = TurnId.make(`${id}-t1`);

  const turn = new Turn({
    id: turnId,
    sessionId: created.id,
    index: 0,
    prompt: `prompt of ${id}`,
    attachments: [],
    model: null,
    effort: null,
    status: "working",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: at,
    endedAt: null,
  });

  return [
    DomainEvent.cases.SessionCreated.make({ session: created }),
    DomainEvent.cases.TurnStarted.make({ turn }),
    DomainEvent.cases.TurnItemCompleted.make({
      sessionId: created.id,
      turnId,
      item: TurnItem.cases.AssistantMessage.make({ id: `${id}-m1`, text: "done", startedAt: null }),
      subagentId: null,
    }),
    DomainEvent.cases.ApprovalRequested.make({
      request: new ApprovalRequest({
        id: RequestId.make(`${id}-r1`),
        sessionId: created.id,
        turnId,
        kind: "command",
        title: "run ls",
        detail: null,
        options: [],
        openedAt: at,
      }),
    }),
  ];
};

const run = <A, E>(filename: string, program: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(program.pipe(Effect.provide(EventStore.layerSqlite(filename))));

const commit = (id: string, events: ReadonlyArray<DomainEvent>) =>
  Effect.flatMap(EventStore, (store) =>
    store.commit({ commandId: CommandId.make(id), decide: () => Effect.succeed(events) })
  );

const seed = Effect.gen(function* () {
  yield* commit("seed", [
    DomainEvent.cases.WorkspaceRegistered.make({ workspace: workspace(GONE) }),
    DomainEvent.cases.WorkspaceRegistered.make({ workspace: workspace(KEPT) }),
    ...sessionEvents("s-gone-1", GONE),
    ...sessionEvents("s-gone-2", GONE),
    ...sessionEvents("s-kept", KEPT),
    constellation("c-gone", GONE, SessionId.make("s-gone-1")),
    constellation("c-kept", KEPT, SessionId.make("s-kept")),
  ]);
});

const remove = commit("remove", [DomainEvent.cases.WorkspaceRemoved.make({ workspaceId: GONE })]);

/** What a Client could see of the model: ids per kind. */
const visible = (model: ReadModel) => ({
  workspaces: [...model.workspaces.keys()].map(String).toSorted(),
  sessions: [...model.sessions.keys()].map(String).toSorted(),
  constellations: [...model.constellations.keys()].map(String).toSorted(),
});

const PURGED = {
  workspaces: [String(KEPT)],
  sessions: ["s-kept"],
  constellations: ["c-kept"],
};

const SESSION_TABLES = ["turns", "turn_items", "pending_approvals"] as const;

const rowsOf = (file: string) => {
  const db = new Database(file, { readonly: true });

  try {
    const sessionsIn = (table: string) =>
      db
        .query<{ id: string }, []>(`SELECT DISTINCT session_id AS id FROM ${table}`)
        .all()
        .map((row) => row.id)
        .toSorted();

    return {
      workspaces: db
        .query<{ id: string }, []>("SELECT id FROM workspaces")
        .all()
        .map((row) => row.id),
      sessions: db
        .query<{ id: string }, []>("SELECT id FROM sessions")
        .all()
        .map((row) => row.id),
      bySessionTable: Object.fromEntries(SESSION_TABLES.map((t) => [t, sessionsIn(t)])),
      sequences: db
        .query<{ sequence: number }, []>("SELECT sequence FROM events ORDER BY sequence")
        .all()
        .map((row) => row.sequence),
    };
  } finally {
    db.close();
  }
};

const storeFile = () => join(tempDir("polaris-removal-"), "state.sqlite");

describe("removing a Workspace", () => {
  test("purges its sessions and constellations from the read model, and keeps the others", async () => {
    const file = storeFile();

    const [before, after] = await run(
      file,
      Effect.gen(function* () {
        yield* seed;
        const store = yield* EventStore;
        const seeded = visible(yield* store.model);
        yield* remove;

        return [seeded, visible(yield* store.model)] as const;
      })
    );

    expect(before.sessions).toEqual(["s-gone-1", "s-gone-2", "s-kept"]);
    expect(before.constellations).toEqual(["c-gone", "c-kept"]);
    expect(after).toEqual(PURGED);
  });

  test("deletes its sessions' rows from every projection table, and keeps every event", async () => {
    const file = storeFile();
    await run(file, seed);
    const seededEvents = rowsOf(file).sequences.length;
    await run(file, remove);

    const rows = rowsOf(file);

    expect(rows.workspaces).toEqual([KEPT]);
    expect(rows.sessions).toEqual(["s-kept"]);
    expect(rows.bySessionTable).toEqual({
      turns: ["s-kept"],
      turn_items: ["s-kept"],
      pending_approvals: ["s-kept"],
    });
    // The log is append-only and gapless: the removal is one more event.
    expect(rows.sequences).toEqual(Array.from({ length: seededEvents + 1 }, (_, i) => i + 1));
  });

  test("a restart loads the purged state, Constellations folded from the log included", async () => {
    const file = storeFile();
    await run(file, Effect.andThen(seed, remove));

    const reloaded = await run(
      file,
      Effect.flatMap(EventStore, (store) => Effect.map(store.model, visible))
    );

    expect(reloaded).toEqual(PURGED);
  });

  test("replaying the whole log reaches the same purged model", async () => {
    const file = storeFile();

    const [live, replayed] = await run(
      file,
      Effect.gen(function* () {
        yield* seed;
        yield* remove;
        const store = yield* EventStore;
        const model = yield* store.model;
        const log = yield* store.readEvents({ after: 0, upTo: model.sequence, sessionId: null });

        return [visible(model), visible(log.reduce(project, emptyModel))] as const;
      })
    );

    expect(replayed).toEqual(PURGED);
    expect(replayed).toEqual(live);
  });
});
