/** Snapshot retention follows real Engine archive/removal, including non-git Workspaces. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Command, SessionId, SessionPlacement, TurnId } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { SchemaSnapshots } from "../data/schemaSnapshots.ts";
import { SchemaStore } from "../data/schemaStore.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "./testing.ts";

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "test" })
  );

test("archive and non-git Workspace removal delete persisted Schema Diff snapshots", async () => {
  const db = new Database(":memory:");
  const records = new SchemaStore(db);

  const snapshots = Layer.succeed(
    SchemaSnapshots,
    SchemaSnapshots.of({
      get: (input) => Effect.sync(() => records.diff(input.sessionId, input.turn)),
      remove: (sessionId) => Effect.sync(() => records.remove(sessionId)),
    })
  );

  const root = tempDir();
  const sessionId = SessionId.make("schema-session");

  const layer = engineLayer({
    filename: join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [makeFakeDriver("claude", { onTurn: completesTurns() })],
  }).pipe(Layer.provide(snapshots));

  const seed = () =>
    records.put({
      sessionId,
      turn: TurnId.make("t"),
      index: 0,
      checkout: root,
      source: { id: "app", name: "app" },
      target: "local",
      baseline: "turn-start",
      before: null,
      after: null,
      used: true,
      failed: false,
    });

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* dispatch(Command.cases.RegisterWorkspace.make({ path: root, name: null }));
        const model = yield* waitFor((m) => m.workspaces.size === 1);
        const workspace = [...model.workspaces.values()][0]!;
        expect(workspace.isGitRepo).toBe(false);
        yield* dispatch(
          Command.cases.StartSession.make({
            sessionId,
            workspaceId: workspace.id,
            harness: "claude",
            placement: SessionPlacement.cases.InPlace.make({}),
            permissionMode: "supervised",
            model: null,
            effort: null,
            prompt: "start",
            attachments: [],
          })
        );
        yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");
        seed();
        expect(records.records(sessionId)).toHaveLength(1);
        yield* dispatch(
          Command.cases.ArchiveSession.make({ sessionId, deleteMergedBranch: false })
        );
        yield* waitUntil(() => records.records(sessionId).length === 0);
        expect(records.records(sessionId)).toEqual([]);
        // An imported/orphaned catalog still belongs to its removed Workspace's session.
        seed();
        yield* dispatch(Command.cases.RemoveWorkspace.make({ workspaceId: workspace.id }));
        yield* waitUntil(() => records.records(sessionId).length === 0);
        expect(records.records(sessionId)).toEqual([]);
      }).pipe(Effect.provide(layer))
    );
  } finally {
    db.close();
  }
});
