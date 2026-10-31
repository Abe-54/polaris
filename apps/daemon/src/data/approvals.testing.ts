import { DomainEvent, Workspace } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { initialSnapshot, stepModel } from "../engine/session.testing.ts";
import { DataDatabase } from "./database.ts";
import { DataApprovals } from "./approvals.ts";

export const started = stepModel(
  initialSnapshot(),
  { type: "start" },
  { harness: "codex", liveCoAttach: true, switchModel: true }
).next.machine.context.record!;

export const seedDataSession = Effect.gen(function* () {
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
        DomainEvent.cases.SessionCreated.make({ session: started.session }),
        DomainEvent.cases.TurnStarted.make({ turn: started.turns[0]! }),
      ]),
  });
});

export const approvalLayer = () =>
  DataApprovals.layer.pipe(
    Layer.provideMerge(DataDatabase.layerAt(":memory:")),
    Layer.provideMerge(EventStore.layerSqlite(":memory:"))
  );
