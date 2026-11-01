import { AgentSession, DomainEvent, Workspace } from "@polaris/protocol";
import { Effect, Layer, Schema } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { initialSnapshot, stepModel } from "../engine/session.testing.ts";
import { DataDatabase } from "./database.ts";
import { DataApprovals } from "./approvals.ts";

export const started = stepModel(
  initialSnapshot(),
  { type: "start" },
  { harness: "codex", liveCoAttach: true, switchModel: true }
).next.machine.context.record!;

export const seedDataSessionAt = (cwd: string) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    yield* store.commit({
      commandId: null,
      decide: () =>
        Effect.succeed([
          DomainEvent.cases.WorkspaceRegistered.make({
            workspace: new Workspace({
              id: started.session.workspaceId,
              path: "/model",
              name: "model",
              isGitRepo: true,
              worktreeRoot: "/model.worktrees",
              hidden: false,
              registeredAt: started.session.createdAt,
            }),
          }),
          DomainEvent.cases.SessionCreated.make({
            session: new AgentSession({
              ...Schema.decodeUnknownSync(Schema.Struct(AgentSession.fields))(started.session),
              cwd,
            }),
          }),
          DomainEvent.cases.TurnStarted.make({ turn: started.turns[0]! }),
        ]),
    });
  });

export const seedDataSession = seedDataSessionAt(started.session.cwd);

export const approvalLayer = () =>
  DataApprovals.layer.pipe(
    Layer.provideMerge(DataDatabase.layerAt(":memory:")),
    Layer.provideMerge(EventStore.layerSqlite(":memory:"))
  );
