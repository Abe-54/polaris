import { expect, test } from "bun:test";
import {
  Attempt,
  CommandId,
  Constellation,
  ConstellationSettings,
  DomainEvent,
  HostId,
  RemoteWorkerAssignment,
  Task,
} from "@polaris/protocol";
import { Context, Effect, Exit, Layer, Struct } from "effect";
import { AT, CID, LEAD, WS, draft, task } from "../../engine/constellation.testing.ts";
import { HostResources } from "../../resources/index.ts";
import { McpTokens } from "../../mcp/index.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { session, wait } from "../delivery/testing.ts";
import { ConstellationOwner } from "../runtime.ts";
import { RemoteWorkers, type RemoteWorkerHooks } from "./assignments.ts";
import { connectFake, fakeHost } from "./fakeHost.testing.ts";
import { remoteWorkingAttemptsLayer } from "./remoteWorking.ts";
import { TransferStorage } from "./storage.ts";

// ENG-349: Start reaches a stalled worker placed on a remote worker Host, not only a local one.
test("Start on a remote worker Host restarts a stalled worker's startup once, behind a fresh slot", async () => {
  const root = newTempDir("remote-start-", { short: true });
  let held = 0;
  let resumes = 0;
  let real: RemoteWorkerHooks | undefined;
  const fallback = Context.get(Context.empty(), RemoteWorkers);

  // The Host's RPC handlers read RemoteWorkers at build; the real layer needs the Host's store.
  const workers: RemoteWorkerHooks = {
    ...fallback,
    restartStartup: (attemptId) => real!.restartStartup!(attemptId),
  };

  const resources = HostResources.of({
    get: Effect.die("unused"),
    declare: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    release: () => Effect.die("unused"),
    setWorkerCap: () => Effect.die("unused"),
    acquire: () => Effect.die("unused"),
    acquireWorker: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          held++;
        }),
        () =>
          Effect.sync(() => {
            held--;
          })
      ),
  });

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* fakeHost(root, { workers });
          const attempt = Attempt.make(Struct.assign(draft(), { hostId: worker.host.hostId }));

          const assignment = RemoteWorkerAssignment.make({
            graph: Constellation.make({
              id: CID,
              hostId: HostId.make("owner"),
              workspaceId: WS,
              leadSessionId: LEAD,
              name: "remote start",
              state: "running",
              revision: 1,
              settings: ConstellationSettings.make({}),
              tasks: [Task.make(Struct.assign(task(), { revision: 0, canceled: false }))],
              attempts: [attempt],
              pendingNotifications: [],
              createdAt: AT,
              updatedAt: AT,
            }),
            attemptId: attempt.id,
            repoPath: root,
          });

          yield* worker.store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.SessionCreated.make({ session: session(attempt.sessionId) }),
              ]),
          });

          const built = yield* Layer.build(
            remoteWorkingAttemptsLayer({
              prepare: () => Effect.die("unused"),
              // The first startup takes its slot and never sends the brief.
              start: () => Effect.never,
              // The brief Turn commits the startup receipt, as startAttempt does.
              resume: () =>
                worker.store
                  .commit({
                    commandId: CommandId.make(`${attempt.id}:start`),
                    decide: () => Effect.succeed([]),
                  })
                  .pipe(
                    Effect.orDie,
                    Effect.tap(() =>
                      Effect.sync(() => {
                        resumes++;
                      })
                    ),
                    Effect.asVoid
                  ),
              failed: () => Effect.void,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(EventStore)(worker.store),
                  Layer.succeed(TransferStorage)(worker.storage),
                  McpTokens.layer(`${root}/tokens.sqlite`),
                  Layer.succeed(HostResources)(resources),
                  Layer.succeed(ConstellationOwner)(worker.host.hostId)
                )
              )
            )
          );

          real = Context.get(built, RemoteWorkers);
          yield* worker.storage.assign(assignment);
          yield* real.assigned(assignment);
          yield* wait(() => Effect.succeed(held === 1));

          const rpc = yield* connectFake(worker.server.socketPath);
          const start = rpc.client["constellation.worker.start"];
          const result = yield* start({ constellationId: CID, attemptId: attempt.id });
          expect(result.summary).toStartWith("Starting");
          yield* wait(() => Effect.succeed(resumes === 1));
          expect(held).toBe(1);

          // Its brief went out: a second Start is refused and sends nothing.
          const again = yield* Effect.exit(start({ constellationId: CID, attemptId: attempt.id }));
          expect(Exit.isFailure(again)).toBe(true);
          expect(JSON.stringify(again)).toContain("E-NOT-STALLED");
          expect(resumes).toBe(1);
        })
      )
    );
  } finally {
    removeTempDir(root);
  }
});
