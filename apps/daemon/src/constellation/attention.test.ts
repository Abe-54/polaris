import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  AgentSession,
  CommandId,
  type ConstellationCommand,
  ConstellationQuestion,
  ConstellationSettings,
  DomainEvent,
  PlanOperation,
  ReviewAction,
  SessionId,
  Workspace,
} from "@polaris/protocol";
import { Effect, Layer, Predicate } from "effect";
import {
  apply,
  AT,
  C,
  CID,
  claimed,
  ctx,
  dispatched,
  draft,
  foldDecision,
  HOST,
  LEAD,
  task,
  WS,
} from "../engine/constellation.testing.ts";
import { notifier, NotifyOutcome } from "../mcp/sessions/index.ts";
import type { ConstellationRecord } from "../store/constellation.ts";
import { EventStore } from "../store/EventStore.ts";
import { attentionOf, startAttention } from "./attention.ts";
import { ConstellationOwner, ConstellationRuntime } from "./runtime.ts";
import { Constellations } from "./service.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const WORKER = SessionId.make("worker");

/** What waits on the user after `command`. */
const notices = (
  record: ConstellationRecord,
  command: ConstellationCommand,
  context = ctx({ binding: { kind: "session", sessionId: WORKER } })
) => attentionOf(apply(record, command, context));

const ask = (to: "user" | "lead", id = "base") =>
  C.WorkerAsk.make({
    constellationId: CID,
    attemptId: draft().id,
    question: new ConstellationQuestion({
      id,
      to,
      text: "Which base should I use?",
      blocking: true,
    }),
  });

describe("attention", () => {
  test("a worker's question to the user notifies on the Lead's session, about the worker", () => {
    expect(notices(dispatched(), ask("user"))).toEqual([
      {
        sessionId: LEAD,
        constellationId: CID,
        about: [WORKER],
        id: `attention:${CID}:question:a1:base`,
        title: "A asks you",
        body: "Which base should I use?",
      },
    ]);
  });

  test("a question to the Lead doesn't notify the user", () => {
    expect(notices(dispatched(), ask("lead"))).toEqual([]);
  });

  test("a Claim the Lead hands up notifies with the Lead's reason", () => {
    const record = apply(
      claimed(),
      C.Review.make({
        constellationId: CID,
        attemptId: draft().id,
        revision: claimed().graph.attempts[0]!.revision,
        action: ReviewAction.cases.Approve.make({}),
      })
    );

    const handUp = C.Review.make({
      constellationId: CID,
      attemptId: draft().id,
      revision: record.graph.attempts[0]!.revision,
      action: ReviewAction.cases.HandUp.make({ reason: "Choose the design" }),
    });

    const [notice, ...rest] = notices(
      record,
      handUp,
      ctx({ binding: { kind: "session", sessionId: LEAD } })
    );

    expect(rest).toEqual([]);
    expect(notice).toMatchObject({
      sessionId: LEAD,
      about: [WORKER],
      title: "A's claim needs your review",
      body: "Choose the design",
    });
    expect(notice?.id).toStartWith(`attention:${CID}:handup:a1:`);
  });

  test("a completed Constellation never notifies", () => {
    const asked = apply(
      dispatched(),
      ask("user"),
      ctx({ binding: { kind: "session", sessionId: WORKER } })
    );

    const done = foldDecision(asked, [
      DomainEvent.cases.ConstellationStateChanged.make({
        constellationId: CID,
        revision: asked.graph.revision + 1,
        state: "completed",
      }),
    ]);

    expect(attentionOf(asked)).toHaveLength(1);
    expect(attentionOf(done)).toEqual([]);
  });
});

const session = (id: SessionId) =>
  new AgentSession({
    id,
    workspaceId: WS,
    harness: "codex",
    title: id,
    cwd: "/tmp",
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
    createdAt: AT,
    updatedAt: AT,
  });

const layer = (file: string) =>
  Constellations.layer.pipe(
    Layer.provideMerge(EventStore.layerSqlite(file)),
    Layer.provide(Layer.succeed(ConstellationOwner)(HOST)),
    Layer.provide(
      Layer.succeed(ConstellationRuntime)({
        prepare: () =>
          Effect.succeed({
            attempts: [draft()],
            newLeadSessionId: null,
            claimProbe: null,
            recordedChecks: [],
          }),
        afterCommit: () => Effect.void,
        resumeWorking: () => Effect.void,
      })
    )
  );

const user = { kind: "user" as const };

test("a question to the user is one SessionNotified on the Lead; the agents' notify after it collapses", async () => {
  const dir = newTempDir("attention-");

  try {
    const [notifications, outcomes] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* store.commit({
            commandId: CommandId.make("seed"),
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.WorkspaceRegistered.make({
                  workspace: new Workspace({
                    id: WS,
                    path: "/tmp",
                    name: "test",
                    isGitRepo: true,
                    worktreeRoot: "/tmp/trees",
                    hidden: false,
                    registeredAt: AT,
                  }),
                }),
                DomainEvent.cases.SessionCreated.make({ session: session(LEAD) }),
                DomainEvent.cases.SessionCreated.make({ session: session(WORKER) }),
              ]),
          });
          const notes = notifier(store);
          yield* startAttention(store, notes);
          const graphs = yield* Constellations;
          yield* graphs.command(
            user,
            CommandId.make("plan"),
            C.Plan.make({
              constellationId: CID,
              start: {
                name: "Build",
                workspaceId: WS,
                leadSessionId: LEAD,
                settings: new ConstellationSettings({}),
              },
              operations: [PlanOperation.cases.Add.make({ task: task() })],
            })
          );
          yield* graphs.command(
            user,
            CommandId.make("dispatch"),
            C.Dispatch.make({ constellationId: CID })
          );
          yield* graphs.command(
            { kind: "session", sessionId: WORKER },
            CommandId.make("ask"),
            ask("user")
          );

          const notified = Effect.gen(function* () {
            const model = yield* store.model;

            const events = yield* store.readEvents({
              after: 0,
              upTo: model.sequence,
              sessionId: null,
              eventTypes: ["SessionNotified"],
            });

            return events.flatMap((e) =>
              Predicate.isTagged(e.event, "SessionNotified") ? [e.event] : []
            );
          });

          for (let i = 0; i < 100 && (yield* notified).length === 0; i++)
            yield* Effect.sleep("20 millis");

          const echoes = [
            yield* notes.notify(
              LEAD,
              { title: "Question for you", body: "" },
              CommandId.make("n1")
            ),
            yield* notes.notify(WORKER, { title: "I asked", body: "" }, CommandId.make("n2")),
          ];

          return [yield* notified, echoes] as const;
        })
      ).pipe(Effect.provide(layer(join(dir, "state.sqlite"))))
    );

    expect(
      notifications.map((e) => [e.sessionId, e.notification.title, e.notification.automatic])
    ).toEqual([[LEAD, "A asks you", true]]);
    expect(outcomes).toEqual([NotifyOutcome.Collapsed(), NotifyOutcome.Collapsed()]);
  } finally {
    removeTempDir(dir);
  }
});
