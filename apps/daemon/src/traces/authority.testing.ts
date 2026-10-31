import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentSession, CommandId, DomainEvent, Turn, TurnId, Workspace } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { TraceRuntime } from "./runtime.ts";
import { TraceSessions } from "./sessions.ts";
import { TraceStore } from "./store.ts";
import { TEST_SESSION, TEST_WORKSPACE } from "./testing.ts";

export const at = "2026-10-31T00:00:00.000Z";

export const commit = (events: ReadonlyArray<DomainEvent>) =>
  Effect.flatMap(EventStore, (store) =>
    store.commit({
      commandId: CommandId.make(crypto.randomUUID()),
      decide: () => Effect.succeed(events),
    })
  );

export const turn = (index: number) =>
  new Turn({
    id: TurnId.make(`turn-${index}`),
    sessionId: TEST_SESSION,
    index,
    prompt: "trace test",
    attachments: [],
    model: null,
    effort: null,
    status: "working",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: new Date(Date.parse(at) + index * 1000).toISOString(),
    endedAt: null,
  });

export const seed = (root: string) =>
  commit([
    DomainEvent.cases.WorkspaceRegistered.make({
      workspace: new Workspace({
        id: TEST_WORKSPACE,
        path: root,
        name: "fixture",
        isGitRepo: false,
        worktreeRoot: `${root}.worktrees`,
        hidden: false,
        registeredAt: at,
      }),
    }),
    DomainEvent.cases.SessionCreated.make({
      session: new AgentSession({
        id: TEST_SESSION,
        workspaceId: TEST_WORKSPACE,
        harness: "claude",
        title: "trace test",
        cwd: join(root, "package"),
        worktreeId: null,
        state: "working",
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
      }),
    }),
  ]);

export const withAuthority = async (
  run: (root: string, layer: ReturnType<typeof authorityLayer>) => Promise<void>
) => {
  const root = await mkdtemp("/tmp/tf1-authority-");

  try {
    await mkdir(join(root, "package"));
    await run(root, authorityLayer(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const authorityLayer = (root: string) => {
  const events = EventStore.layerSqlite(join(root, "events.sqlite"));
  const sessions = TraceSessions.layer.pipe(Layer.provideMerge(events));

  return TraceRuntime.layerAt(join(root, "tokens.json")).pipe(
    Layer.provideMerge(TraceStore.layerAt(join(root, "traces.sqlite"))),
    Layer.provideMerge(sessions)
  );
};
