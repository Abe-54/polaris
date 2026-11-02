import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  Command,
  DomainEvent,
  WorktreeSetup,
  WorktreeSetupRun,
  SessionId,
  ConstellationId,
  TaskId,
} from "@polaris/protocol";
import { Effect, Predicate, Stream } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { eventCapability } from "../store/model.ts";
import { makeRepo, removeTempDir } from "../git/testing.ts";
import { session } from "../constellation/delivery/testing.ts";
import { decideSession } from "./session.ts";
import { Engine } from "./Engine.ts";
import { cid, engineLayer, makeFakes, makeFakeDriver } from "./testing.ts";

test("Workspace setup survives visibility edits and reload; Turn-less failure hydrates Host and Session snapshots", async () => {
  const root = await makeRepo();
  const SID = SessionId.make("setup-session");
  const setting = WorktreeSetup.cases.Command.make({ command: "make setup" });

  const card = new WorktreeSetupRun({
    id: "setup",
    constellationId: ConstellationId.make("graph"),
    taskId: TaskId.make("A"),
    command: "make setup",
    cwd: root,
    status: "failed",
    output: "missing compiler",
    exitCode: 7,
    startedAt: "2026-10-02T00:00:00.000Z",
    endedAt: "2026-10-02T00:00:01.000Z",
  });

  const layer = () =>
    engineLayer({
      filename: join(root, "state.sqlite"),
      fakes: makeFakes(),
      drivers: [makeFakeDriver("codex")],
    });

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* Engine;
          const store = yield* EventStore;

          const dispatch = (command: Command) =>
            engine.dispatch({ commandId: cid(), deviceLabel: "test", command });

          yield* dispatch(Command.cases.RegisterWorkspace.make({ path: root, name: "repo" }));
          const workspace = [...(yield* store.model).workspaces.values()][0]!;
          yield* dispatch(
            Command.cases.SetWorktreeSetup.make({ workspaceId: workspace.id, setup: setting })
          );
          yield* dispatch(
            Command.cases.SetWorkspaceHidden.make({ workspaceId: workspace.id, hidden: true })
          );
          expect((yield* store.model).workspaces.get(workspace.id)?.worktreeSetup).toEqual(setting);
          yield* store.commit({
            commandId: cid(),
            decide: () =>
              Effect.succeed(
                decideSession(undefined, { type: "session.fork", session: session(SID) }).events
              ),
          });

          for (const status of ["running", "failed"] as const) {
            const setup = new WorktreeSetupRun({
              id: card.id,
              constellationId: card.constellationId,
              taskId: card.taskId,
              command: card.command,
              cwd: card.cwd,
              status,
              output: card.output,
              exitCode: card.exitCode,
              startedAt: card.startedAt,
              endedAt: card.endedAt,
            });

            yield* store.commit({
              commandId: cid(),
              decide: (model) =>
                Effect.succeed(
                  decideSession(model.sessions.get(SID), { type: "session.setup", setup }).events
                ),
            });
          }
        })
      ).pipe(Effect.provide(layer()))
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* Engine;

          const [host] = yield* engine
            .subscribeHost(null, { capabilities: ["workspace.setup"] })
            .pipe(Stream.take(1), Stream.runCollect);

          expect(Predicate.isTagged(host, "Snapshot")).toBe(true);

          if (host !== undefined && Predicate.isTagged(host, "Snapshot")) {
            expect(host.workspaces[0]?.worktreeSetup).toEqual(setting);
            expect(host.sessions.find((s) => s.session.id === SID)?.session.worktreeSetup).toEqual(
              card
            );
            expect(host.sessions.find((s) => s.session.id === SID)?.session.state).toBe("failed");
          }

          const [snapshot] = yield* engine
            .subscribeSession({
              sessionId: SID,
              afterSequence: null,
              turnLimit: null,
              capabilities: ["workspace.setup"],
            })
            .pipe(Stream.take(1), Stream.runCollect);

          if (snapshot !== undefined && Predicate.isTagged(snapshot, "Snapshot")) {
            expect(snapshot.session.worktreeSetup).toEqual(card);
            expect(snapshot.turns).toHaveLength(0);
          } else throw new Error("missing Session snapshot");
          expect(
            eventCapability(
              DomainEvent.cases.SessionSetupChanged.make({ sessionId: SID, setup: card })
            )
          ).toBe("workspace.setup");
        })
      ).pipe(Effect.provide(layer()))
    );
  } finally {
    removeTempDir(root);
  }
});
