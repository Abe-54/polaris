import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentSession,
  Attempt,
  CommandId,
  DomainEvent,
  PreparedWorktree,
  ReviewAction,
  TurnId,
  WorkerPlacement,
  WorktreeSetup,
  WorktreeSetupRun,
} from "@polaris/protocol";
import { Effect, Layer, Struct } from "effect";
import {
  AT,
  C,
  CID,
  HOST,
  WS,
  draft,
  planned,
  task,
  report,
} from "../../engine/constellation.testing.ts";
import { makeRepo, removeDir, tempDir } from "../../git/testing.ts";
import { HarnessRegistry } from "../../services.ts";
import { makeFakeDriver } from "../../engine/testing.ts";
import { WorktreeSetupService } from "../setup/index.ts";
import { setupFingerprint } from "../setup/inputs.ts";
import { changeTrust } from "../setup/trust.testing.ts";
import { finish, send, setup, signal, world, wait } from "../delivery/testing.ts";
import { restartForRetry } from "../../mcp/sendback.restart.testing.ts";
import { Constellations } from "../service.ts";
import { ConstellationRuntime } from "../runtime.ts";
import { ConstellationSessionEffects } from "../delivery/inputs.ts";
import { workingAttemptsLayer } from "../working.ts";
import { startAttempt } from "./workers.ts";
import { EventStore } from "../../store/EventStore.ts";
import { recordSendbackTrace } from "../../mcp/sendback.trace.testing.ts";
import { prepareSession } from "./prepare.ts";
import { posixTest } from "../../platform/testing.ts";

const shellSetupTest = posixTest(
  "setup commands here are POSIX shell lines; Windows runs setup under cmd.exe (ENG-318)"
);

const command = "echo run >> setup-count";

const setting = WorktreeSetup.cases.Command.make({ command });

const inputAt = (root: string) => ({
  key: "retry",
  graph: planned().graph,
  task: task(),
  previous: Attempt.make(Struct.assign(draft(), { worktree: root })),
  placement: WorkerPlacement.cases.Existing.make({ sessionId: draft().sessionId }),
  worktree: PreparedWorktree.make({
    repoPath: root,
    worktree: root,
    branch: draft().branch,
    base: draft().base,
    managed: false,
    managedBranch: false,
  }),
  worktreeSetup: setting,
});

test("fingerprints cover command and root/nested manifests and ecosystem lockfiles", async () => {
  const root = await makeRepo();

  try {
    let previous = await Effect.runPromise(setupFingerprint(root, command));
    expect(await Effect.runPromise(setupFingerprint(root, "echo changed"))).not.toBe(previous);
    await mkdir(join(root, "packages/worker"), { recursive: true });

    for (const file of [
      "packages/worker/package.json",
      "package.json",
      "bun.lock",
      "yarn.lock",
      "Cargo.lock",
      "go.sum",
      "Gemfile.lock",
      "poetry.lock",
      ".tool-versions",
      "requirements.txt",
      "requirements-dev.txt",
      "packages/worker/requirements-prod.txt",
    ]) {
      await writeFile(join(root, file), "changed");
      const next = await Effect.runPromise(setupFingerprint(root, command));
      expect(next).not.toBe(previous);
      previous = next;
    }
  } finally {
    removeDir(root);
  }
});

for (const interrupted of [false, true])
  shellSetupTest(
    interrupted
      ? "deferred setup a restart interrupted reruns after restart, then the brief starts once"
      : "busy worktree reuse persists deferred setup and production restart runs it before the brief",
    async () => {
      const root = await makeRepo({ ".gitignore": "*.sqlite*\nsetup-count\n" });

      try {
        const file = join(root, "state.sqlite");
        const input = inputAt(root);
        let attempt = draft();
        let prepared = Attempt.make(Struct.assign(draft(), { worktree: root }));

        const runtime = Layer.succeed(ConstellationRuntime)({
          prepare: () =>
            Effect.succeed({
              attempts: [prepared],
              newLeadSessionId: null,
              recordedChecks: [],
              claimProbe: { dirtyPaths: [], branch: draft().branch, head: "head" },
            }),
          resumeWorking: () => Effect.void,
          afterCommit: () => Effect.void,
        });

        const w = world(file, { runtime });
        await w.run(
          Effect.gen(function* () {
            yield* setup();
            const store = yield* EventStore;
            const old = (yield* store.model).sessions.get(draft().sessionId)!.session;
            // The provisioned Session uses this worktree, while the preceding Turn is still working.
            yield* store.commit({
              commandId: null,
              decide: () =>
                Effect.succeed([
                  DomainEvent.cases.SessionCreated.make({
                    session: AgentSession.make(Struct.assign(old, { cwd: root })),
                  }),
                ]),
            });
            yield* (yield* WorktreeSetupService).run(
              old.id,
              "initial",
              root,
              setting,
              CID,
              draft().taskId,
              WS
            );
            yield* send(old.id, "Earlier work");
            attempt = yield* prepareSession(input, HOST).pipe(
              Effect.provideService(HarnessRegistry, {
                get: () => Effect.succeed(makeFakeDriver("codex").driver),
                all: Effect.succeed([]),
              })
            );
            expect(attempt.startupSetup).toEqual({ command, force: false });
            expect((yield* store.model).sessions.get(old.id)!.session.worktreeSetup?.status).toBe(
              "completed"
            );
            prepared = attempt;
            const graphs = yield* Constellations;
            const initial = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;
            yield* graphs.command(
              { kind: "session", sessionId: initial.sessionId },
              CommandId.make("claim"),
              C.WorkerClaim.make({ constellationId: CID, attemptId: initial.id, claim: report() })
            );
            const review = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;
            yield* graphs.command(
              { kind: "user" },
              CommandId.make("sendback"),
              C.Review.make({
                constellationId: CID,
                attemptId: initial.id,
                revision: review.revision,
                action: ReviewAction.cases.SendBack.make({
                  reason: "Refresh setup",
                  worker: input.placement,
                }),
              })
            );
            attempt = (yield* store.model).constellations.get(CID)!.graph.attempts.at(-1)!;
            expect(attempt.startupSetup).toEqual({ command, force: false });
            yield* changeTrust(root, HOST, WS, "trust");

            // The Daemon stops while this Attempt's deferred setup is running.
            if (interrupted) {
              yield* finish(old.id);
              yield* signal(old.id, {
                type: "session.setup",
                setup: new WorktreeSetupRun({
                  id: `${attempt.id}:setup:stopped`,
                  constellationId: CID,
                  taskId: attempt.taskId,
                  command,
                  cwd: root,
                  status: "running",
                  output: "",
                  exitCode: null,
                  startedAt: AT,
                  endedAt: null,
                }),
              });
            }
          })
        );
        await writeFile(join(root, "package.json"), "{}\n");
        const turn = await restartForRetry(root, attempt, undefined, true);
        expect(turn.id).toEqual(TurnId.make(`${attempt.id}:start`));
        expect(await readFile(join(root, "setup-count"), "utf8")).toBe("run\nrun\n");
        await world(file).run(
          Effect.gen(function* () {
            const store = yield* EventStore;
            const record = (yield* store.model).sessions.get(attempt.sessionId)!;
            expect(record.session.worktreeSetup?.status).toBe("completed");
            expect(record.session.worktreeSetup?.fingerprint).toBe(
              yield* setupFingerprint(root, command)
            );
            yield* recordSendbackTrace("deferred-setup-restart");
          })
        );
      } finally {
        removeDir(root);
      }
    },
    20000
  );

test("failed deferred setup releases the acquired worker slot and creates no startup receipt or brief", async () => {
  const root = tempDir();
  let held = 0;
  let failed = false;

  const attempt = Attempt.make(
    Struct.assign(draft(), { worktree: root, startupSetup: { command: "exit 7", force: true } })
  );

  const runtime = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* EventStore;

      const context = yield* Effect.context<
        EventStore | ConstellationSessionEffects | import("../setup/index.ts").WorktreeSetupService
      >();

      const start = () =>
        Effect.gen(function* () {
          const graph = (yield* store.model).constellations.get(CID)!.graph;
          yield* startAttempt(graph, attempt);
        }).pipe(Effect.provide(context));

      return workingAttemptsLayer({
        runtime: {
          prepare: () =>
            Effect.succeed({
              attempts: [attempt],
              newLeadSessionId: null,
              recordedChecks: [],
              claimProbe: null,
            }),
          resumeWorking: () => Effect.void,
          afterCommit: () => Effect.void,
        },
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
        startWorker: start,
        resumeWorker: start,
        failed: () =>
          Effect.sync(() => {
            failed = true;
          }),
      }).pipe(Layer.provide(Layer.succeed(EventStore)(store)));
    })
  );

  try {
    const w = world(":memory:", { runtime });
    await w.run(
      Effect.gen(function* () {
        yield* setup();
        yield* wait(() => Effect.succeed(failed && held === 0));
        const store = yield* EventStore;
        expect((yield* store.model).sessions.get(attempt.sessionId)!.session.state).toBe("failed");
        expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(false);
        expect(w.turns).toHaveLength(0);
        expect(w.retired).toHaveLength(0);
      })
    );
  } finally {
    removeDir(root);
  }
});

shellSetupTest(
  "setup persists its resulting inputs once and unchanged reuse does not run again",
  async () => {
    const root = await makeRepo({ ".gitignore": "setup-count\n" });
    const changedCommand = "echo changed > yarn.lock; echo run >> setup-count";

    try {
      await world().run(
        Effect.gen(function* () {
          yield* setup();
          const service = yield* WorktreeSetupService;
          const setting = WorktreeSetup.cases.Command.make({ command: changedCommand });
          const sid = draft().sessionId;
          const first = yield* service.run(sid, "first", root, setting, CID, draft().taskId, WS);
          expect(first?.fingerprint).toBe(yield* setupFingerprint(root, changedCommand));

          const second = yield* service.run(
            sid,
            "next-attempt",
            root,
            setting,
            CID,
            draft().taskId,
            WS
          );

          expect(second?.id).toBe(first?.id);
          expect(yield* Effect.promise(() => readFile(join(root, "setup-count"), "utf8"))).toBe(
            "run\n"
          );

          const forced = yield* service.run(
            sid,
            "merge-conflict",
            root,
            setting,
            CID,
            draft().taskId,
            WS,
            true
          );

          expect(forced?.id).not.toBe(first?.id);
          expect(yield* Effect.promise(() => readFile(join(root, "setup-count"), "utf8"))).toBe(
            "run\nrun\n"
          );
        })
      );
    } finally {
      removeDir(root);
    }
  }
);
