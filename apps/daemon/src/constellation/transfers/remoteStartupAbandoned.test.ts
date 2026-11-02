import { expect, test } from "bun:test";
import {
  CommandId,
  Constellation,
  ConstellationSettings,
  HostId,
  RemoteWorkerAssignment,
  Task,
} from "@polaris/protocol";
import { Context, Effect, Layer, Struct } from "effect";
import { AT, CID, HOST, LEAD, WS, draft, task } from "../../engine/constellation.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { HostResources } from "../../resources/index.ts";
import { withWorkerAdmission } from "../../resources/workerAdmission.ts";
import { McpTokens } from "../../mcp/index.ts";
import { ConstellationOwner } from "../runtime.ts";
import { session, wait } from "../delivery/testing.ts";
import { DomainEvent } from "@polaris/protocol";
import { StartupAbandoned } from "../composition/startupAbandoned.ts";
import { RemoteWorkers } from "./assignments.ts";
import { TransferStorage } from "./storage.ts";
import { remoteWorkingAttemptsLayer } from "./remoteWorking.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

for (const mode of ["start", "resume"] as const)
  test(`remote ${mode} abandonment preserves assignment and reacquires admission before input`, async () => {
    const root = newTempDir("remote-startup-failure-", { short: true });
    let held = 0;
    let failures = 0;
    let abandoned = false;

    let executions = 0;
    const attempt = draft();

    const assignment = RemoteWorkerAssignment.make({
      graph: Constellation.make({
        id: CID,
        hostId: HostId.make("owner"),
        workspaceId: WS,
        leadSessionId: LEAD,
        name: "remote failure",
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
        Effect.gen(function* () {
          const context = yield* Layer.build(
            Layer.mergeAll(
              EventStore.layerSqlite(`${root}/store.sqlite`),
              TransferStorage.layer(`${root}/transfers.sqlite`),
              McpTokens.layer(`${root}/tokens.sqlite`),
              Layer.succeed(HostResources)(resources),
              Layer.succeed(ConstellationOwner)(HOST)
            )
          );

          const store = Context.get(context, EventStore);
          const storage = Context.get(context, TransferStorage);
          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.SessionCreated.make({ session: session(attempt.sessionId) }),
              ]),
          });
          yield* storage.assign(assignment);

          const abandon = store
            .commit({
              commandId: CommandId.make(`${attempt.id}:startup-failed`),
              decide: () => Effect.succeed([]),
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  abandoned = true;
                })
              ),
              Effect.andThen(Effect.fail(new StartupAbandoned({ attemptId: attempt.id })))
            );

          const workerContext = yield* Layer.build(
            remoteWorkingAttemptsLayer({
              prepare: () => Effect.die("unused"),
              start: () => abandon,
              resume: () => abandon,
              failed: () =>
                Effect.sync(() => {
                  failures++;
                }),
            }).pipe(Layer.provide(Layer.succeedContext(context)))
          );

          const workers = Context.get(workerContext, RemoteWorkers);

          yield* mode === "resume" ? workers.resume(assignment) : workers.assigned(assignment);
          yield* wait(() => Effect.succeed(abandoned && held === 0));

          for (let i = 0; i < 2; i++) {
            const user = yield* withWorkerAdmission(
              store,
              attempt.sessionId,
              Effect.sync(() => {
                expect(held).toBe(1);
                executions++;

                return "executed";
              })
            ).pipe(Effect.timeout(200));

            expect(user).toBe("executed");
            yield* wait(() => Effect.succeed(held === 0));
          }

          expect(failures).toBe(0);
          expect(executions).toBe(2);
          expect(yield* storage.assignments).toEqual([assignment]);
        }).pipe(Effect.scoped)
      );
    } finally {
      removeTempDir(root);
    }
  });
