import { expect, test } from "bun:test";
import {
  Attempt,
  CommandId,
  CommandRejected,
  Constellation,
  ConstellationSettings,
  HostId,
  RemoteWorkerAssignment,
  ResourceError,
  Task,
} from "@polaris/protocol";
import { Context, Effect, Layer, Struct } from "effect";
import { AT, CID, HOST, LEAD, WS, draft, task } from "../../engine/constellation.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { HostResources } from "../../resources/index.ts";
import { hasWorkerAdmission, withWorkerAdmission } from "../../resources/workerAdmission.ts";
import { McpTokens } from "../../mcp/index.ts";
import { ConstellationOwner } from "../runtime.ts";
import {
  applyWorkerDelivery,
  ConstellationSessionEffects,
  DeliveryInput,
} from "../delivery/index.ts";
import { session, wait } from "../delivery/testing.ts";
import { DomainEvent } from "@polaris/protocol";
import { RemoteWorkers } from "./assignments.ts";
import { TransferStorage } from "./storage.ts";
import { remoteWorkingAttemptsLayer } from "./remoteWorking.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

for (const mode of ["acquire", "start", "resume"] as const)
  for (const ending of ["settle", "archive"] as const)
    test(`remote ${mode} failure fence ends after ${ending}, allowing ordinary Session input`, async () => {
      const root = newTempDir("remote-startup-failure-", { short: true });
      let held = 0;
      let failures = 0;

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
          mode === "acquire"
            ? Effect.fail(new ResourceError({ message: "acquire failed" }))
            : Effect.acquireRelease(
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

            const workerContext = yield* Layer.build(
              remoteWorkingAttemptsLayer({
                prepare: () => Effect.die("unused"),
                start: () => Effect.fail("start failed"),
                resume: () => Effect.fail("resume failed"),
                failed: () =>
                  Effect.sync(() => {
                    failures++;
                  }),
              }).pipe(Layer.provide(Layer.succeedContext(context)))
            );

            const workers = Context.get(workerContext, RemoteWorkers);

            yield* mode === "resume" ? workers.resume(assignment) : workers.assigned(assignment);
            yield* wait(() => Effect.succeed(failures === 1 && held === 0));

            const effects = ConstellationSessionEffects.of({
              canSteer: () => Effect.succeed(true),
              runTurn: () =>
                Effect.sync(() => {
                  executions++;
                }),
              steer: () =>
                Effect.sync(() => {
                  executions++;
                }),
              retire: () => Effect.void,

              interrupt: () => Effect.void,
            });

            for (let i = 0; i < 2; i++) {
              const user = yield* withWorkerAdmission(
                store,
                attempt.sessionId,
                Effect.sync(() => {
                  executions++;
                })
              ).pipe(Effect.timeout(200));

              expect(user).toBeUndefined();
              const id = `failed-remote-${mode}-${i}`;

              const error = yield* applyWorkerDelivery(
                {
                  id,
                  ownerHostId: assignment.graph.hostId,
                  workerHostId: HOST,
                  constellationId: CID,
                  attemptId: attempt.id,
                  sessionId: attempt.sessionId,
                  input: DeliveryInput.Turn({ text: "Resume failed worker", cause: "unblock" }),
                },
                () => Effect.void
              ).pipe(
                Effect.provideService(EventStore, store),
                Effect.provideService(ConstellationSessionEffects, effects),
                Effect.flip,

                Effect.timeout(200)
              );

              expect(error).toBeInstanceOf(CommandRejected);

              if (!(error instanceof CommandRejected)) throw error;
              expect(error.reason).toContain("admission closed");

              expect(yield* store.hasCommandReceipt(CommandId.make(id))).toBe(false);
            }

            expect(executions).toBe(0);
            expect(yield* storage.assignments).toEqual([assignment]);

            const terminal = RemoteWorkerAssignment.make(
              Struct.assign(assignment, {
                graph: Constellation.make(
                  Struct.assign(assignment.graph, {
                    state: ending === "archive" ? ("archived" as const) : ("running" as const),
                    revision: 2,
                    attempts: [
                      ending === "settle"
                        ? Attempt.make(
                            Struct.assign(attempt, { state: "failed" as const, endedAt: AT })
                          )
                        : attempt,
                    ],
                  })
                ),
              })
            );

            yield* storage.assign(terminal);
            yield* workers.assigned(terminal);
            expect(hasWorkerAdmission(store, attempt.sessionId)).toBe(false);

            const ordinary = yield* withWorkerAdmission(
              store,
              attempt.sessionId,
              Effect.sync(() => {
                executions++;

                return "ordinary";
              })
            ).pipe(Effect.timeout(200));

            expect(ordinary).toBe("ordinary");
            expect(executions).toBe(1);
          }).pipe(Effect.scoped)
        );
      } finally {
        removeTempDir(root);
      }
    });
