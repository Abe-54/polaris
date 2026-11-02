import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  Attempt,
  AttemptId,
  CommandId,
  DomainEvent,
  PlanOperation,
  Workspace,
  type RemoteWorkerAssignment,
  type Turn,
} from "@polaris/protocol";
import { Context, Deferred, Effect, Layer, Struct } from "effect";
import { CID, LEAD, WS, AT, C, ctx, draft, report, task } from "../engine/constellation.testing.ts";
import { decideConstellation } from "../engine/constellation.ts";
import { EventStore } from "../store/EventStore.ts";
import { HostResources } from "../resources/index.ts";
import { McpTokens } from "./tokens.ts";
import { McpBinding } from "./binding.ts";
import { FriendlyReview } from "./tools/inputs.ts";
import { callSendbackTool } from "./sendback.tools.testing.ts";
import { ConstellationOwner } from "../constellation/runtime.ts";
import { ConstellationSessionEffects } from "../constellation/delivery/inputs.ts";
import { finish, session, send, signal } from "../constellation/delivery/testing.ts";
import { WorktreeSetupService } from "../constellation/setup/index.ts";
import { startAttempt, startPendingAttempt } from "../constellation/composition/workers.ts";
import { remoteWorkingAttemptsLayer } from "../constellation/transfers/remoteWorking.ts";
import { RemoteWorkers, type RemoteWorkerHooks } from "../constellation/transfers/assignments.ts";
import { TransferStorage } from "../constellation/transfers/storage.ts";
import { ConstellationOutbox } from "../constellation/transfers/outbox.ts";
import { withRemoteWorkerCommands } from "../constellation/transfers/commands.ts";
import {
  fakeHost,
  connectFake,
  fixtureSession,
} from "../constellation/transfers/fakeHost.testing.ts";
import { makeRepo, removeTempDir } from "../git/testing.ts";
import { gitText } from "../git/git.ts";
import {
  mirrorRemoteAssignments,
  relayOutboxPacket,
} from "../../../../packages/client/src/constellation/transfer.ts";
import { trustedSetup } from "../constellation/setup/trust.testing.ts";
import { shortTemp } from "../platform/testing.ts";

interface WorkerBridge {
  hooks?: RemoteWorkerHooks;
}

type Host = Effect.Success<ReturnType<typeof fakeHost>>;

const mount = Effect.fnUntraced(function* (
  host: Host,
  root: string,
  onTurn: (t: Turn) => Effect.Effect<void>,
  onResume: () => Effect.Effect<void>
) {
  const resources = HostResources.of({
    get: Effect.die("unused"),
    declare: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    release: () => Effect.die("unused"),

    setWorkerCap: () => Effect.die("unused"),
    acquire: () => Effect.die("unused"),
    acquireWorker: () => Effect.void,
  });

  const effects = ConstellationSessionEffects.of({
    runTurn: onTurn,
    canSteer: () => Effect.succeed(false),

    steer: () => Effect.die("unused"),
    retire: () => Effect.void,
    interrupt: () => Effect.die("unused"),
  });

  const context = yield* Layer.build(
    remoteWorkingAttemptsLayer({
      prepare: () => Effect.die("unused"),
      start: (assignment) =>
        startAttempt(
          assignment.graph,
          assignment.graph.attempts.find((a) => a.id === assignment.attemptId)!
        ),
      resume: (assignment) =>
        startPendingAttempt(
          assignment.graph,
          assignment.graph.attempts.find((a) => a.id === assignment.attemptId)!
        ).pipe(Effect.andThen(onResume())),
      failed: () => Effect.die("unexpected remote startup failure"),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(EventStore)(host.store),
          WorktreeSetupService.layer.pipe(
            Layer.provide(trustedSetup),
            Layer.provide(Layer.succeed(EventStore)(host.store))
          ),
          Layer.succeed(TransferStorage)(host.storage),
          Layer.succeed(ConstellationOwner)(host.host.hostId),
          Layer.succeed(HostResources)(resources),
          Layer.succeed(ConstellationSessionEffects)(effects),
          McpTokens.layer(join(root, "tokens.sqlite"))
        )
      )
    )
  );

  return Context.get(context, RemoteWorkers);
});

const graphOf = (host: Host) =>
  host.store.model.pipe(Effect.map((m) => m.constellations.get(CID)!.graph));

const commitAttempt = (host: Host, attempt: Attempt) =>
  host.store.commit({
    commandId: CommandId.make("dispatch"),
    decide: (model) => {
      const decision = decideConstellation(
        model.constellations.get(CID),

        C.Dispatch.make({ constellationId: CID }),
        ctx({ hostId: host.host.hostId, attempts: [attempt] })
      );

      expect(decision.rejection).toBeNull();

      return Effect.succeed(decision.events);
    },
  });

test("remote MCP SendBack feedback survives outbox relay and worker restart before delivery; resume ignores evicted first Turn", async () => {
  const ownerRoot = mkdtempSync(shortTemp("sendback-owner-"));
  const workerRoot = mkdtempSync(shortTemp("sendback-remote-"));
  const repo = await makeRepo();
  const reason = 'Keep "both tests".\n\nRemote Unicode λ feedback stays verbatim.  ';
  let pending: RemoteWorkerAssignment | undefined;

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* fakeHost(workerRoot);
          const branch = yield* Effect.promise(() => gitText(repo, ["branch", "--show-current"]));
          const head = yield* Effect.promise(() => gitText(repo, ["rev-parse", "HEAD"]));

          const initial = Attempt.make(
            Struct.assign(draft(), {
              hostId: worker.host.hostId,
              worktree: repo,

              branch,
              base: head,
            })
          );

          const retry = Attempt.make(
            Struct.assign(initial, { id: AttemptId.make("remote-retry") })
          );

          const owner = yield* fakeHost(ownerRoot, {
            runtime: {
              prepare: () =>
                Effect.succeed({
                  attempts: [retry],
                  newLeadSessionId: null,
                  claimProbe: null,
                  recordedChecks: [],
                }),

              afterCommit: () => Effect.void,
              resumeWorking: () => Effect.void,
            },
          });

          yield* owner.store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.WorkspaceRegistered.make({
                  workspace: Workspace.make({
                    id: WS,
                    path: repo,
                    name: "remote",
                    isGitRepo: true,
                    worktreeRoot: `${repo}.worktrees`,
                    hidden: false,
                    registeredAt: AT,
                  }),
                }),
                DomainEvent.cases.SessionCreated.make({ session: fixtureSession(repo) }),
              ]),
          });
          yield* owner.graphs.command(
            { kind: "user" },
            CommandId.make("plan"),
            C.Plan.make({
              constellationId: CID,
              start: { name: "remote", workspaceId: WS, leadSessionId: LEAD },
              operations: [PlanOperation.cases.Add.make({ task: task() })],
            })
          );
          yield* commitAttempt(owner, initial);
          yield* worker.store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.SessionCreated.make({ session: session(initial.sessionId) }),
              ]),
          });
          const ownerRpc = yield* connectFake(owner.server.socketPath);
          const workerRpc = yield* connectFake(worker.server.socketPath);
          yield* mirrorRemoteAssignments(yield* graphOf(owner), workerRpc);

          const commands = yield* withRemoteWorkerCommands(worker.graphs).pipe(
            Effect.provideService(TransferStorage, worker.storage),
            Effect.provideService(ConstellationOutbox, worker.outbox)
          );

          yield* Effect.promise(() =>
            callSendbackTool(
              McpBinding.cases.Worker.make({
                sessionId: initial.sessionId,
                constellationId: CID,
                attemptId: initial.id,
              }),
              commands,
              "claim",
              { claim: report(branch, head) }
            )
          );
          const packet = (yield* worker.storage.packets)[0]!;
          yield* relayOutboxPacket(workerRpc, ownerRpc, packet);
          expect(yield* worker.storage.packets).toEqual([]);
          const previous = (yield* graphOf(owner)).attempts[0]!;
          yield* Effect.promise(() =>
            callSendbackTool(
              McpBinding.cases.Lead.make({ sessionId: LEAD, constellationId: CID }),
              owner.graphs,
              "review",
              {
                task: "A",
                revision: previous.revision,
                action: FriendlyReview.cases.SendBack.make({
                  reason,
                  worker: { session: initial.sessionId },
                  mergeConflictBase: head,
                }),
              }
            )
          );
          yield* mirrorRemoteAssignments(yield* graphOf(owner), workerRpc);
          pending = (yield* worker.storage.assignments).find((a) => a.attemptId === retry.id)!;
          expect(pending.graph.attempts[0]!.rejectionReason).toBe(reason);
          expect((yield* worker.store.model).sessions.get(initial.sessionId)!.turns).toHaveLength(
            0
          );
        })
      ).pipe(Effect.timeout("10 seconds"))
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge: WorkerBridge = {};

          const worker = yield* fakeHost(workerRoot, {
            workers: {
              prepare: () => Effect.die("unused"),
              assigned: (a) => bridge.hooks!.assigned(a),

              resume: (a) => bridge.hooks!.resume(a),
              claimed: (id) => bridge.hooks!.claimed(id),
            },
          });

          const delivered = yield* Deferred.make<Turn>();
          const resumed = yield* Deferred.make<void>();
          bridge.hooks = yield* mount(
            worker,
            workerRoot,
            (turn) => Deferred.succeed(delivered, turn).pipe(Effect.asVoid),
            () => Deferred.succeed(resumed, undefined).pipe(Effect.asVoid)
          );
          yield* worker.assignments.resumeWorking();
          const turn = yield* Deferred.await(delivered);
          yield* Deferred.await(resumed);
          expect(turn.prompt).toContain(`Review feedback:\n${reason}`);
          expect(turn.prompt).toContain(JSON.stringify(pending!.graph.attempts[0]!.claim));

          expect(turn.prompt).toStartWith(
            `Merge conflict: merge ${pending!.graph.attempts[0]!.base} into your branch first`
          );
          expect((yield* worker.store.model).constellations.size).toBe(0);

          for (let i = 0; i < 34; i++) {
            yield* finish(turn.sessionId).pipe(Effect.provideService(EventStore, worker.store));
            yield* send(turn.sessionId).pipe(Effect.provideService(EventStore, worker.store));
          }

          expect(
            (yield* worker.store.model).sessions
              .get(turn.sessionId)!
              .turns.some((t) => t.id === turn.id)
          ).toBe(false);
        })
      ).pipe(Effect.timeout("10 seconds"))
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge: WorkerBridge = {};

          const worker = yield* fakeHost(workerRoot, {
            workers: {
              prepare: () => Effect.die("unused"),
              assigned: (a) => bridge.hooks!.assigned(a),

              resume: (a) => bridge.hooks!.resume(a),
              claimed: (id) => bridge.hooks!.claimed(id),
            },
          });

          yield* signal(pending!.graph.attempts.at(-1)!.sessionId, {
            type: "daemon.recover",
            cause: "restart",
            at: AT,
          }).pipe(Effect.provideService(EventStore, worker.store));
          expect(
            (yield* worker.store.model).sessions.get(pending!.graph.attempts.at(-1)!.sessionId)!
              .session.state
          ).toBe("needs-you");

          const resumed = yield* Deferred.make<void>();
          bridge.hooks = yield* mount(
            worker,
            workerRoot,
            () => Effect.die("startup must not repeat"),

            () => Deferred.succeed(resumed, undefined).pipe(Effect.asVoid)
          );
          yield* worker.assignments.resumeWorking();
          yield* Deferred.await(resumed);

          const turns = yield* worker.store.readTurns({
            sessionId: pending!.graph.attempts.at(-1)!.sessionId,
            beforeIndex: null,
            limit: null,
          });

          expect(turns.filter((t) => t.id === "remote-retry:start")).toHaveLength(1);
        })
      ).pipe(Effect.timeout("5 seconds"))
    );
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
    removeTempDir(repo);
  }
}, 30000);
