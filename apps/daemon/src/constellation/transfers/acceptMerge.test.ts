import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  Attempt,
  CommandId,
  type ConstellationCommand,
  DomainEvent,
  PlanOperation,
  ReviewAction,
  WorkerPlacement,
  Workspace,
} from "@polaris/protocol";
import { Context, Effect, Layer, Struct } from "effect";
import { gitText } from "../../git/git.ts";
import { mergedInto } from "../../git/constellationBundles.ts";
import { commitAll, makeRepo, removeTempDir, write } from "../../git/testing.ts";
import { shortTemp } from "../../platform/testing.ts";
import { McpTokens } from "../../mcp/tokens.ts";
import { EventStore } from "../../store/EventStore.ts";
import { decideConstellation } from "../../engine/constellation.ts";
import {
  AT,
  C,
  CID,
  HOST,
  LEAD,
  WS,
  ctx,
  draft,
  report,
  task,
} from "../../engine/constellation.testing.ts";
import type { ConstellationContext } from "../../engine/constellation.inputs.ts";
import { ConstellationDefaultsPath } from "../defaults.ts";
import { ConstellationOwner, ConstellationRuntime } from "../runtime.ts";
import { Constellations } from "../service.ts";
import { ConstellationWorktrees } from "../worktrees.ts";
import { fixtureSession } from "./fakeHost.testing.ts";
import { withWorktreePreparation } from "./preparation.ts";
import { TransferStorage } from "./storage.ts";

const id = (name: string) => CommandId.make(name);

/** Commits a command as the decider would, without the runtime: the scene before the Accept. */
const decided = (commandId: string, command: ConstellationCommand, context: ConstellationContext) =>
  Effect.gen(function* () {
    const store = yield* EventStore;

    yield* store.commit({
      commandId: id(commandId),
      decide: (model) => {
        const decision = decideConstellation(model.constellations.get(CID), command, context);

        return decision.rejection === null
          ? Effect.succeed(decision.events)
          : Effect.fail(decision.rejection);
      },
    });
  });

const layers = (root: string) => {
  const base = Layer.mergeAll(
    EventStore.layerSqlite(join(root, "store.sqlite")),
    McpTokens.layer(join(root, "tokens.sqlite")),
    ConstellationWorktrees.layer.pipe(Layer.provideMerge(TransferStorage.layer(":memory:")))
  ).pipe(Layer.provideMerge(Layer.succeed(ConstellationOwner)(HOST)));

  const runtime = Layer.effect(
    ConstellationRuntime,
    withWorktreePreparation(Context.get(Context.empty(), ConstellationRuntime))
  );

  return Constellations.layer.pipe(
    Layer.provideMerge(runtime.pipe(Layer.provideMerge(base))),
    Layer.provide(Layer.succeed(ConstellationDefaultsPath)(join(root, "defaults.json")))
  );
};

test("the user's Accept merges the claimed head it saw into the Lead's branch, never an older one", async () => {
  const root = mkdtempSync(shortTemp("c1am-"));
  const repo = await makeRepo();
  const tree = `${repo}.worktrees/A`;

  try {
    await gitText(repo, ["worktree", "add", "-q", "-b", "polaris/A", tree]);
    const attempt = Attempt.make(Struct.assign(draft(), { worktree: tree, branch: "polaris/A" }));
    const worker = { kind: "session" as const, sessionId: attempt.sessionId };

    const claim = (name: string, head: string) =>
      decided(
        name,
        C.WorkerClaim.make({
          constellationId: CID,
          attemptId: attempt.id,
          claim: report(attempt.branch, head),
        }),
        ctx({ binding: worker, claimProbe: { dirtyPaths: [], branch: attempt.branch, head } })
      );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore;
          const graphs = yield* Constellations;
          yield* store.commit({
            commandId: id("seed"),
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.WorkspaceRegistered.make({
                  workspace: Workspace.make({
                    id: WS,
                    path: repo,
                    name: "accept",
                    isGitRepo: true,
                    worktreeRoot: `${repo}.worktrees`,
                    hidden: false,
                    registeredAt: AT,
                  }),
                }),
                DomainEvent.cases.SessionCreated.make({ session: fixtureSession(repo) }),
              ]),
          });
          yield* decided(
            "plan",
            C.Plan.make({
              constellationId: CID,
              start: { name: "accept", workspaceId: WS, leadSessionId: LEAD },
              operations: [PlanOperation.cases.Add.make({ task: task() })],
            }),
            ctx()
          );
          yield* decided(
            "dispatch",
            C.Dispatch.make({
              constellationId: CID,
              tasks: [
                {
                  taskId: attempt.taskId,
                  worker: WorkerPlacement.cases.Existing.make({ sessionId: attempt.sessionId }),
                },
              ],
            }),
            ctx({ attempts: [attempt] })
          );

          write(tree, "work.txt", "first\n");
          const first = yield* Effect.promise(() => commitAll(tree, "first"));
          yield* claim("claim-1", first);

          const seenFirst = (yield* graphs.status({ kind: "user" }, CID, true)).constellation!
            .attempts[0]!.revision;

          write(repo, "lead.txt", "the lead moved on\n");
          const leadBefore = yield* Effect.promise(() => commitAll(repo, "lead"));
          write(tree, "work.txt", "amended\n");
          const amended = yield* Effect.promise(() => commitAll(tree, "amended"));
          yield* claim("claim-2", amended);

          const seenAmended = (yield* graphs.status({ kind: "user" }, CID, true)).constellation!
            .attempts[0]!.revision;

          yield* decided(
            "progress",
            C.WorkerProgress.make({ constellationId: CID, attemptId: attempt.id, note: "idle" }),
            ctx({ binding: worker })
          );

          const accept = (name: string, revision: number, head: string) =>
            graphs
              .command(
                { kind: "user" },
                id(name),
                C.Review.make({
                  constellationId: CID,
                  attemptId: attempt.id,
                  revision,
                  action: ReviewAction.cases.Accept.make({ mergedHead: head, receipts: [] }),
                })
              )
              .pipe(
                Effect.as("accepted"),
                Effect.catchTag("ConstellationRejected", (e) =>
                  Effect.succeed(e.findings.map((f) => f.code).join(","))
                )
              );

          expect(yield* accept("stale", seenFirst, first)).toContain("E-REVISION");
          expect(yield* Effect.promise(() => gitText(repo, ["rev-parse", "HEAD"]))).toBe(
            leadBefore
          );
          expect(yield* Effect.promise(() => mergedInto(repo, first, "HEAD"))).toBe(false);

          expect(yield* accept("current", seenAmended, amended)).toBe("accepted");

          const accepted = (yield* graphs.status({ kind: "user" }, CID, true)).constellation!
            .attempts[0]!;

          expect(accepted.state).toBe("accepted");
          expect(accepted.mergedHead).toBe(amended);
          expect(
            yield* Effect.promise(() => gitText(repo, ["rev-parse", "HEAD^1", "HEAD^2"]))
          ).toBe(`${leadBefore}\n${amended}`);
        })
      ).pipe(Effect.provide(layers(root)))
    );
  } finally {
    removeTempDir(root);
    removeTempDir(`${repo}.worktrees`);
    removeTempDir(repo);
  }
}, 15_000);
