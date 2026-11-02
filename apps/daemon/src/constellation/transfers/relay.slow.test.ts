import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Attempt,
  AttemptId,
  CommandId,
  DomainEvent,
  Workspace,
  ReviewAction,
  PlanOperation,
  WorkerPlacement,
  RemoteWorkerAssignment,
  RemotePlacementRequest,
  RemoteDeliveryPacket,
  RemoteDeliveryInput,
  Sequence,
  SessionId,
  TaskId,
} from "@polaris/protocol";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Scope,
  Exit,
  Predicate,
  Stream,
  Context,
  Struct,
  SubscriptionRef,
} from "effect";
import { fakeHost, connectFake, fixtureSession, testIdentity } from "./fakeHost.testing.ts";
import { makeRepo, removeDir, write, commitAll } from "../../git/testing.ts";
import { gitText, resolveCommit } from "../../git/git.ts";
import { constellationRef } from "../../git/constellationBundles.ts";
import {
  C,
  CID,
  LEAD,
  WS,
  AT,
  ctx,
  draft,
  report,
  task,
} from "../../engine/constellation.testing.ts";
import { decideConstellation } from "../../engine/constellation.ts";
import {
  relayOutboxPacket,
  prepareRemotePlacement,
  relayRemoteDelivery,
} from "../../../../../packages/client/src/constellation/transfer.ts";
import { ConstellationRelay } from "../../../../../packages/client/src/constellation/relay.ts";
import { HostRegistry } from "../../../../../packages/client/src/HostRegistry.ts";
import { HostConnector, HostTarget } from "../../../../../packages/client/src/HostConnection.ts";
import { type ConstellationRuntimeService } from "../runtime.ts";
import { shortTemp } from "../../platform/testing.ts";

interface RelayTraceBatch {
  hostId: string;
  events: DomainEvent[];
  outboxId?: string;
}

const id = (name: string) => CommandId.make(name);

const roots = () => ({
  owner: mkdtempSync(shortTemp("c1wo-")),
  worker: mkdtempSync(shortTemp("c1ww-")),
});

const seed = Effect.fnUntraced(function* (
  owner: Effect.Success<ReturnType<typeof fakeHost>>,
  repo: string
) {
  yield* owner.store.commit({
    commandId: id("lead"),
    decide: () =>
      Effect.succeed([
        DomainEvent.cases.WorkspaceRegistered.make({
          workspace: Workspace.make({
            id: WS,
            path: repo,
            name: "relay",
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
    id("plan"),
    C.Plan.make({
      constellationId: CID,
      start: { name: "relay", workspaceId: WS, leadSessionId: LEAD },
      operations: [PlanOperation.cases.Add.make({ task: task() })],
    })
  );
});

const commit = Effect.fnUntraced(function* (
  owner: Effect.Success<ReturnType<typeof fakeHost>>,
  commandId: string,
  command: import("@polaris/protocol").ConstellationCommand,
  attempts: ReadonlyArray<Attempt> = []
) {
  return yield* owner.store.commit({
    commandId: id(commandId),
    decide: (model) => {
      const decision = decideConstellation(
        model.constellations.get(CID),
        command,
        ctx({ hostId: owner.host.hostId, attempts, commanded: true })
      );

      return decision.rejection === null
        ? Effect.succeed(decision.events)
        : Effect.fail(decision.rejection);
    },
  });
});

const graphOf = (owner: Effect.Success<ReturnType<typeof fakeHost>>) =>
  owner.store.model.pipe(Effect.map((model) => model.constellations.get(CID)!.graph));

const prepare = Effect.fnUntraced(function* (
  owner: Effect.Success<ReturnType<typeof fakeHost>>,
  worker: Effect.Success<ReturnType<typeof fakeHost>>,
  repo: string
) {
  const ownerRpc = yield* connectFake(owner.server.socketPath);
  const workerRpc = yield* connectFake(worker.server.socketPath);
  const baseHead = yield* Effect.promise(() => gitText(repo, ["rev-parse", "HEAD"]));

  const request = RemotePlacementRequest.make({
    id: "dispatch:A",
    graph: yield* graphOf(owner),
    task: task(),
    worker: WorkerPlacement.cases.New.make({ hostId: worker.host.hostId }),
    sessionId: null,
    previous: null,
    baseHead,
  });

  const preparing = yield* owner.placements.request(request).pipe(Effect.forkChild);
  const attempt = yield* prepareRemotePlacement(ownerRpc, workerRpc, request);
  expect(yield* Fiber.join(preparing)).toEqual(attempt);
  yield* commit(owner, "dispatch", C.Dispatch.make({ constellationId: CID }), [attempt]);
  yield* worker.assignments.set(
    RemoteWorkerAssignment.make({
      graph: yield* graphOf(owner),
      attemptId: attempt.id,
      repoPath: attempt.worktree,
    })
  );

  return { ownerRpc, workerRpc, attempt };
});

const workerHooks = (counts?: { starts: number }) => ({
  prepare: (
    request: RemotePlacementRequest,
    prepared: import("@polaris/protocol").PreparedWorktree
  ) =>
    Effect.promise(async () => {
      await gitText(prepared.worktree, ["config", "user.name", "Test"]);
      await gitText(prepared.worktree, ["config", "user.email", "test@example.com"]);
      await gitText(prepared.worktree, ["config", "commit.gpgsign", "false"]);

      return Attempt.make(
        Struct.assign(draft(), {
          id: AttemptId.make(request.id),
          hostId: request.worker.hostId,
          taskId: request.task.id,
          sessionId: request.sessionId ?? draft().sessionId,
          worktree: prepared.worktree,
          branch: prepared.branch,
          base: prepared.base,
        })
      );
    }),
  assigned: () =>
    Effect.sync(() => {
      if (counts !== undefined) counts.starts++;
    }),
  resume: () => Effect.void,
  claimed: () => Effect.void,
});

test("two real fake Hosts transfer the base, commit one Claim before fetch, hydrate and acknowledge exactly once", async () => {
  const paths = roots();
  const repo = await makeRepo();

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fakeHost(paths.owner);
          const worker = yield* fakeHost(paths.worker, { workers: workerHooks() });
          yield* seed(owner, repo);
          const { ownerRpc, workerRpc, attempt } = yield* prepare(owner, worker, repo);
          expect((yield* worker.store.model).constellations.size).toBe(0);
          write(attempt.worktree, "work", "claimed work");
          const head = yield* Effect.promise(() => commitAll(attempt.worktree, "worker Claim"));
          yield* worker.outbox.enqueue(
            { kind: "session", sessionId: attempt.sessionId },
            id("claim"),
            C.WorkerClaim.make({
              constellationId: CID,
              attemptId: attempt.id,
              claim: report(attempt.branch, head),
            })
          );
          const packet = (yield* worker.storage.packets)[0]!;
          const receipt = yield* ownerRpc.client["constellation.outbox.apply"]({ packet });
          expect(Predicate.isTagged(receipt, "Applied")).toBe(true);
          expect((yield* graphOf(owner)).attempts[0]?.state).toBe("review");
          expect(
            (yield* owner.graphs.status({ kind: "user" }, CID, true)).projections[0]?.branchFetched
          ).toBe(false);
          const sequence = (yield* owner.store.model).sequence;
          const updates = yield* owner.branches.subscribe(CID);
          const received = yield* updates.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
          yield* relayOutboxPacket(workerRpc, ownerRpc, packet);
          expect((yield* Fiber.join(received))[0]).toMatchObject({
            attemptId: attempt.id,
            branchFetched: true,
          });
          expect(
            (yield* owner.graphs.status({ kind: "user" }, CID, true)).projections[0]?.branchFetched
          ).toBe(true);

          const snapshot = yield* owner.graphs
            .subscribe({ kind: "user" }, CID, null)
            .pipe(Stream.take(1), Stream.runCollect);

          expect(snapshot[0]).toMatchObject({
            projections: [{ branchFetched: true }],
          });
          yield* relayOutboxPacket(workerRpc, ownerRpc, packet);
          expect((yield* owner.store.model).sequence).toBe(sequence);
          expect(yield* worker.storage.packets).toEqual([]);
          expect((yield* worker.storage.claimedAttempts).has(attempt.id)).toBe(true);
          expect(yield* Effect.promise(() => resolveCommit(repo, "HEAD"))).toBe(attempt.base);
          expect(
            yield* Effect.promise(() => resolveCommit(repo, constellationRef(CID, attempt.id)))
          ).toBe(head);
        })
      )
    );
  } finally {
    removeDir(paths.owner);
    removeDir(paths.worker);
    removeDir(repo);
  }
}, 15_000);

test("remote review re-claim transfers the changed head and preserves the pending Claim guard", async () => {
  const paths = roots();
  const repo = await makeRepo();

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fakeHost(paths.owner);
          const worker = yield* fakeHost(paths.worker, { workers: workerHooks() });
          yield* seed(owner, repo);
          const { ownerRpc, workerRpc, attempt } = yield* prepare(owner, worker, repo);
          const binding = { kind: "session" as const, sessionId: attempt.sessionId };

          const claim = (head: string) =>
            C.WorkerClaim.make({
              constellationId: CID,
              attemptId: attempt.id,
              claim: report(attempt.branch, head),
            });

          write(attempt.worktree, "work", "first Claim");
          const firstHead = yield* Effect.promise(() => commitAll(attempt.worktree, "first"));
          yield* worker.outbox.enqueue(binding, id("first-claim"), claim(firstHead));
          yield* relayOutboxPacket(workerRpc, ownerRpc, (yield* worker.storage.packets)[0]!);
          const previous = (yield* graphOf(owner)).attempts[0]!;
          yield* worker.assignments.set(
            RemoteWorkerAssignment.make({
              graph: yield* graphOf(owner),
              attemptId: attempt.id,
              repoPath: attempt.worktree,
            })
          );

          const unchanged = yield* worker.outbox
            .enqueue(binding, id("unchanged"), claim(firstHead))
            .pipe(
              Effect.as("ok"),
              Effect.catchTag("ConstellationTransferError", (error) => Effect.succeed(error.code))
            );

          expect(unchanged).toBe("E-CLAIM-UNCHANGED");

          write(attempt.worktree, "work", "revised Claim");
          const revisedHead = yield* Effect.promise(() => commitAll(attempt.worktree, "revised"));
          yield* worker.outbox.enqueue(binding, id("revised-claim"), claim(revisedHead));

          const duplicate = yield* worker.outbox
            .enqueue(binding, id("duplicate"), claim(revisedHead))
            .pipe(
              Effect.as("ok"),
              Effect.catchTag("ConstellationTransferError", (error) => Effect.succeed(error.code))
            );

          expect(duplicate).toBe("E-CLAIM-QUEUED");
          expect(yield* worker.storage.packets).toHaveLength(1);
          yield* relayOutboxPacket(workerRpc, ownerRpc, (yield* worker.storage.packets)[0]!);
          const revised = (yield* graphOf(owner)).attempts[0]!;
          expect(revised.id).toBe(previous.id);
          expect(revised.revision).toBe(previous.revision + 1);
          expect(revised.claim?.head).toBe(revisedHead);
          expect(
            yield* Effect.promise(() => resolveCommit(repo, constellationRef(CID, attempt.id)))
          ).toBe(revisedHead);

          const stale = yield* commit(
            owner,
            "old-accept",
            C.Review.make({
              constellationId: CID,
              attemptId: attempt.id,
              revision: previous.revision,
              action: ReviewAction.cases.Accept.make({ mergedHead: firstHead, receipts: [] }),
            })
          ).pipe(
            Effect.as("ok"),
            Effect.catchTag("ConstellationRejected", (error) =>
              Effect.succeed(error.findings[0]?.code)
            )
          );

          expect(stale).toBe("E-REVISION");
        })
      )
    );
  } finally {
    removeDir(paths.owner);
    removeDir(paths.worker);
    removeDir(repo);
  }
}, 15000);

test("worker outbox survives app loss after owner commit and retry after owner settlement", async () => {
  const paths = roots();
  const repo = await makeRepo();
  let packet: import("@polaris/protocol").ConstellationOutboxPacket | null = null;
  let sequence = 0;

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fakeHost(paths.owner);
          const worker = yield* fakeHost(paths.worker, { workers: workerHooks() });
          yield* seed(owner, repo);
          const { attempt } = yield* prepare(owner, worker, repo);
          yield* worker.outbox.enqueue(
            { kind: "session", sessionId: attempt.sessionId },
            id("progress"),
            C.WorkerProgress.make({
              constellationId: CID,
              attemptId: attempt.id,
              note: "durable",
            })
          );
          packet = (yield* worker.storage.packets)[0]!;
          yield* owner.outbox.apply(packet);
          yield* commit(
            owner,
            "stop",
            C.Review.make({
              constellationId: CID,
              attemptId: attempt.id,
              revision: (yield* graphOf(owner)).attempts[0]!.revision,
              action: ReviewAction.cases.Stop.make({ reason: "user stopped" }),
            })
          );
          sequence = (yield* owner.store.model).sequence;
        })
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fakeHost(paths.owner);
          const worker = yield* fakeHost(paths.worker);
          const ownerRpc = yield* connectFake(owner.server.socketPath);
          const workerRpc = yield* connectFake(worker.server.socketPath);
          expect((yield* worker.storage.packets).length).toBe(1);
          yield* relayOutboxPacket(workerRpc, ownerRpc, packet!);
          expect((yield* owner.store.model).sequence).toBe(sequence);
          expect(yield* worker.storage.packets).toEqual([]);
        })
      )
    );
  } finally {
    removeDir(paths.owner);
    removeDir(paths.worker);
    removeDir(repo);
  }
}, 15_000);

const startClient = Effect.fnUntraced(function* (
  paths: { owner: string; worker: string },
  scope: Scope.Scope
) {
  const services = yield* Layer.build(
    HostRegistry.layer.pipe(Layer.provide(HostConnector.layer))
  ).pipe(Scope.provide(scope));

  const registry = Context.get(services, HostRegistry);
  yield* Layer.build(
    ConstellationRelay.layer.pipe(Layer.provide(Layer.succeedContext(services)))
  ).pipe(Scope.provide(scope));

  for (const [key, root] of Object.entries(paths)) {
    const connection = yield* registry
      .add({
        key,
        name: key,
        target: HostTarget.Local({ socketPath: join(root, "daemon.sock") }),
        identity: testIdentity,
      })
      .pipe(Scope.provide(scope));

    yield* connection.awaitSession;
  }

  return registry;
});

test("automatic event-driven relay recovers after the app disconnects between owner commit and receipt, without applying twice", async () => {
  const paths = roots();
  const repo = await makeRepo();

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const committed = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let applications = 0;

          const runtime: ConstellationRuntimeService = {
            prepare: () =>
              Effect.succeed({
                attempts: [],
                newLeadSessionId: null,
                claimProbe: null,
                recordedChecks: [],
              }),
            resumeWorking: () => Effect.void,
            afterCommit: (_, command) =>
              !Predicate.isTagged(command, "WorkerClaim")
                ? Effect.void
                : Effect.gen(function* () {
                    applications++;
                    yield* Deferred.succeed(committed, undefined);
                    yield* Deferred.await(release);
                  }),
          };

          const owner = yield* fakeHost(paths.owner, { runtime });
          const worker = yield* fakeHost(paths.worker, { workers: workerHooks() });
          yield* seed(owner, repo);
          const { attempt } = yield* prepare(owner, worker, repo);
          write(attempt.worktree, "work", "offline relay");
          const head = yield* Effect.promise(() => commitAll(attempt.worktree, "claim"));
          yield* worker.outbox.enqueue(
            { kind: "session", sessionId: attempt.sessionId },
            id("crash-claim"),
            C.WorkerClaim.make({
              constellationId: CID,
              attemptId: attempt.id,
              claim: report(attempt.branch, head),
            })
          );
          const parent = yield* Effect.scope;
          const firstClient = yield* Scope.fork(parent);
          yield* startClient(paths, firstClient);
          yield* Deferred.await(committed);
          yield* Scope.close(firstClient, Exit.void);
          yield* Deferred.succeed(release, undefined);
          expect((yield* graphOf(owner)).attempts[0]?.state).toBe("review");
          expect((yield* owner.storage.receipts).length).toBe(0);
          expect((yield* worker.storage.packets).length).toBe(1);
          const sequence = (yield* owner.store.model).sequence;
          const secondClient = yield* Scope.fork(parent);
          yield* startClient(paths, secondClient);
          yield* SubscriptionRef.changes(worker.storage.changes).pipe(
            Stream.mapEffect(() => worker.storage.packets),
            Stream.filter((packets) => packets.length === 0),
            Stream.take(1),
            Stream.runDrain
          );

          expect((yield* owner.store.model).sequence).toBe(sequence);
          expect(applications).toBe(1);
          expect(
            (yield* owner.graphs.status({ kind: "user" }, CID, true)).projections[0]?.branchFetched
          ).toBe(true);

          const events = yield* owner.store.readConstellationEvents({
            constellationId: CID,
            after: Sequence.make(0),
            upTo: sequence,
          });

          expect(events.filter((e) => Predicate.isTagged(e.event, "AttemptClaimed")).length).toBe(
            1
          );

          expect(
            events.filter((e) => Predicate.isTagged(e.event, "NotificationQueued")).length
          ).toBe(1);

          if (process.env.POLARIS_CONSTELLATION_TRACE_DIR !== undefined) {
            const batches = [];

            for (const commandId of new Set(events.map((e) => e.commandId))) {
              const committed = events.filter((e) => e.commandId === commandId);

              const batch: RelayTraceBatch = {
                hostId: owner.host.hostId,
                events: committed.map((e) => e.event),
              };

              if (commandId?.includes("crash-claim") === true) batch.outboxId = commandId;
              batches.push(batch);
            }

            writeFileSync(
              join(process.env.POLARIS_CONSTELLATION_TRACE_DIR, "w-relay.json"),
              JSON.stringify({ version: 1, ownerHostId: owner.host.hostId, batches })
            );
          }
        })
      )
    ).then();
  } finally {
    removeDir(paths.owner);
    removeDir(paths.worker);
    removeDir(repo);
  }
}, 20_000);

test("remote input receipt survives both sides restarting and acknowledges L without another Session command", async () => {
  const paths = roots();
  const repo = await makeRepo();
  let packet: RemoteDeliveryPacket | null = null;
  let delivered = 0;

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fakeHost(paths.owner);

          const worker = yield* fakeHost(paths.worker, {
            workers: workerHooks(),
            delivery: {
              apply: () =>
                Effect.sync(() => {
                  delivered++;
                }),
            },
          });

          yield* seed(owner, repo);
          const { attempt, workerRpc } = yield* prepare(owner, worker, repo);
          packet = RemoteDeliveryPacket.make({
            id: "answer:A:q1",
            ownerHostId: owner.host.hostId,
            workerHostId: worker.host.hostId,
            constellationId: CID,
            attemptId: attempt.id,
            sessionId: attempt.sessionId,
            input: RemoteDeliveryInput.cases.Turn.make({
              text: "Use the confirmed base",
              cause: "answer",
            }),
          });
          const send = yield* owner.deliveries.send(packet).pipe(Effect.forkChild);
          yield* workerRpc.client["constellation.delivery.apply"]({ packet });
          expect(delivered).toBe(1);
          yield* Fiber.interrupt(send);
        })
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fakeHost(paths.owner);

          const worker = yield* fakeHost(paths.worker, {
            delivery: {
              apply: () =>
                Effect.sync(() => {
                  delivered++;
                }),
            },
          });

          const ownerRpc = yield* connectFake(owner.server.socketPath);
          const workerRpc = yield* connectFake(worker.server.socketPath);
          const replay = yield* owner.deliveries.watch.pipe(Stream.take(1), Stream.runCollect);
          expect(replay[0]).toEqual([packet!]);
          yield* relayRemoteDelivery(ownerRpc, workerRpc, packet!);
          yield* owner.deliveries.send(packet!);
          expect(delivered).toBe(1);
          expect(
            (yield* owner.deliveries.acknowledged.pipe(Stream.take(1), Stream.runCollect))[0]?.map(
              (p) => [p.id, p.sessionId]
            )
          ).toEqual([[packet!.id, packet!.sessionId]]);
          expect(
            (yield* owner.deliveries.watch.pipe(Stream.take(1), Stream.runCollect))[0]
          ).toEqual([]);
          expect(
            yield* worker.deliveries
              .apply(
                RemoteDeliveryPacket.make(
                  Struct.assign(packet!, {
                    input: RemoteDeliveryInput.cases.Steer.make({ text: "different" }),
                  })
                )
              )
              .pipe(Effect.flip)
          ).toMatchObject({ code: "E-IDEMPOTENCY" });
        })
      )
    );
  } finally {
    removeDir(paths.owner);
    removeDir(paths.worker);
    removeDir(repo);
  }
}, 15_000);

test("refused relay receipts survive restart and unchanged retries add no events", async () => {
  const paths = roots();
  const repo = await makeRepo();
  let packet: import("@polaris/protocol").ConstellationOutboxPacket | null = null;
  let refusal: import("@polaris/protocol").ConstellationRelayReceipt | null = null;
  let sequence = 0;

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fakeHost(paths.owner);
          const worker = yield* fakeHost(paths.worker, { workers: workerHooks() });
          yield* seed(owner, repo);
          const { attempt } = yield* prepare(owner, worker, repo);
          yield* worker.outbox.enqueue(
            { kind: "session", sessionId: attempt.sessionId },
            id("late-progress"),
            C.WorkerProgress.make({
              constellationId: CID,
              attemptId: attempt.id,
              note: "queued before stop",
            })
          );
          packet = (yield* worker.storage.packets)[0]!;
          yield* commit(
            owner,
            "stop",
            C.Review.make({
              constellationId: CID,
              attemptId: attempt.id,
              revision: attempt.revision,
              action: ReviewAction.cases.Stop.make({ reason: "stop" }),
            })
          );
          sequence = (yield* owner.store.model).sequence;
          const receipt = yield* owner.outbox.apply(packet);
          refusal = receipt;
          expect(Predicate.isTagged(receipt, "Refused")).toBe(true);
          expect((yield* owner.store.model).sequence).toBe(sequence);
        })
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fakeHost(paths.owner);
          expect(yield* owner.outbox.apply(packet!)).toEqual(refusal!);
          expect((yield* owner.store.model).sequence).toBe(sequence);
        })
      )
    );
  } finally {
    removeDir(paths.owner);
    removeDir(paths.worker);
    removeDir(repo);
  }
});

test("automatic relay delivers another Session while one worker RPC waits for its Turn", async () => {
  const paths = roots();
  const repo = await makeRepo();

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const blocked = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const siblingDelivered = yield* Deferred.make<void>();
          const owner = yield* fakeHost(paths.owner);

          const worker = yield* fakeHost(paths.worker, {
            workers: workerHooks(),
            delivery: {
              apply: (packet) =>
                packet.id === "waiting"
                  ? Deferred.succeed(blocked, undefined).pipe(
                      Effect.andThen(Deferred.await(release))
                    )
                  : Deferred.succeed(siblingDelivered, undefined).pipe(Effect.asVoid),
            },
          });

          yield* seed(owner, repo);
          const { attempt } = yield* prepare(owner, worker, repo);

          const sibling = Attempt.make(
            Struct.assign(attempt, {
              id: AttemptId.make("sibling"),
              taskId: TaskId.make("B"),
              sessionId: SessionId.make("sibling"),
            })
          );

          yield* commit(
            owner,
            "add-sibling",
            C.Plan.make({
              constellationId: CID,
              operations: [PlanOperation.cases.Add.make({ task: task(sibling.taskId) })],
            })
          );
          yield* commit(
            owner,
            "dispatch-sibling",
            C.Dispatch.make({
              constellationId: CID,
              tasks: [
                {
                  taskId: sibling.taskId,
                  worker: WorkerPlacement.cases.Existing.make({ sessionId: sibling.sessionId }),
                },
              ],
            }),
            [sibling]
          );
          const graph = yield* graphOf(owner);
          yield* worker.storage.assign(
            RemoteWorkerAssignment.make({ graph, attemptId: sibling.id, repoPath: repo })
          );

          const packet = (id: string, a: Attempt) =>
            RemoteDeliveryPacket.make({
              id,
              ownerHostId: owner.host.hostId,
              workerHostId: worker.host.hostId,
              constellationId: CID,
              attemptId: a.id,
              sessionId: a.sessionId,
              input: RemoteDeliveryInput.cases.Turn.make({
                text: id,
                cause: id === "waiting" ? "unblock" : "message",
              }),
            });

          yield* startClient(paths, yield* Effect.scope);

          const first = yield* owner.deliveries
            .send(packet("waiting", attempt))
            .pipe(Effect.forkChild);

          yield* Deferred.await(blocked);

          const second = yield* owner.deliveries
            .send(packet("sibling", sibling))
            .pipe(Effect.forkChild);

          yield* Deferred.await(siblingDelivered).pipe(Effect.timeout(2000));
          yield* Fiber.join(second).pipe(Effect.timeout(2000));
          expect(yield* Deferred.isDone(release)).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first).pipe(Effect.timeout(2000));
          expect(
            (yield* owner.deliveries.watch.pipe(Stream.take(1), Stream.runCollect))[0]
          ).toEqual([]);
        })
      )
    );
  } finally {
    removeDir(paths.owner);
    removeDir(paths.worker);
    removeDir(repo);
  }
}, 15_000);
