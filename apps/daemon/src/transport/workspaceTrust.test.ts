import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandId, DomainEvent, Workspace, WorkspaceId } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { changeTrust } from "../constellation/setup/trust.testing.ts";
import { AT, HOST, WS } from "../engine/constellation.testing.ts";
import { makeRepo, removeTempDir, tempDir } from "../git/testing.ts";
import { WorkspaceTrust } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { workspaceTrustLayer } from "./workspaceTrust.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const register = (path: string) =>
  Effect.flatMap(EventStore, (store) =>
    store.commit({
      commandId: CommandId.make("register"),
      decide: () =>
        Effect.succeed([
          DomainEvent.cases.WorkspaceRegistered.make({
            workspace: Workspace.make({
              id: WS,
              path,
              name: "App",
              isGitRepo: true,
              worktreeRoot: `${path}.worktrees`,
              hidden: false,
              registeredAt: AT,
            }),
          }),
        ]),
    })
  );

test("a Workspace is trusted only while the Host's Trust records say so", async () => {
  const repo = await makeRepo();
  const state = tempDir("polaris-state-");
  cleanup.push(repo, state);
  writeFileSync(join(state, "host-id"), `${HOST}\n`);

  const layer = workspaceTrustLayer(state).pipe(
    Layer.provideMerge(EventStore.layerSqlite(join(state, "state.sqlite")))
  );

  const seen = await Effect.runPromise(
    Effect.gen(function* () {
      yield* register(repo);
      const { trusted } = yield* WorkspaceTrust;
      const before = yield* trusted(WS);
      yield* changeTrust(state, HOST, WS, "trust");
      const granted = yield* trusted(WS);
      yield* changeTrust(state, HOST, WS, "revoke");
      const revoked = yield* trusted(WS);
      const unknown = yield* trusted(WorkspaceId.make("elsewhere"));

      return { before, granted, revoked, unknown };
    }).pipe(Effect.provide(layer))
  );

  expect(seen).toEqual({ before: false, granted: true, revoked: false, unknown: false });
});
