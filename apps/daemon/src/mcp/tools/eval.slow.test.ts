import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PlanOperation,
  TaskDefinition,
  TaskId,
  ReviewAction,
  AttemptCause,
  SetConstellationStateAction,
  type ConstellationResult,
} from "@polaris/protocol";
import { Effect, Layer, Predicate } from "effect";
import { Constellations } from "../../constellation/service.ts";
import { ConstellationOwner, ConstellationRuntime } from "../../constellation/runtime.ts";
import { ConstellationDefaultsPath } from "../../constellation/defaults.ts";
import { EventStore } from "../../store/EventStore.ts";
import { McpTokens } from "../tokens.ts";
import { sessionTools } from "../sessions/index.ts";
import { attachSessionTools } from "./index.ts";
import { attachConstellation } from "../../harness/constellation/attachment.ts";
import {
  CID,
  HOST,
  LEAD,
  WS,
  seed,
  runtime,
  repo,
  git,
  leadBinding,
  runAttempt,
  runBenchTurn,
  toolCounter,
} from "./eval.fixture.ts";
import { FriendlyReview, FriendlyAnswer } from "./inputs.ts";
import { makeBenchDriver } from "../../harness/bench/BenchDriver.ts";
import type { Attempt } from "@polaris/protocol";
import { shortTemp } from "../../platform/testing.ts";

test("Lead dispatches three bench workers, sends a Claim back, and accepts the dependent Gate", async () => {
  const root = mkdtempSync(shortTemp("polaris-c1-t-eval-"));
  const starts: Attempt[] = [];
  const counter = toolCounter();

  const base = Layer.mergeAll(
    EventStore.layerSqlite(join(root, "store.sqlite")),
    McpTokens.layer(join(root, "tokens.sqlite"))
  );

  const layers = Constellations.layer.pipe(
    Layer.provideMerge(
      Layer.effect(ConstellationRuntime, runtime(root, starts)).pipe(Layer.provideMerge(base))
    ),
    Layer.provide(Layer.succeed(ConstellationOwner)(HOST)),
    Layer.provide(Layer.succeed(ConstellationDefaultsPath)(join(root, "defaults.json")))
  );

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(root);
          const commands = yield* Constellations;
          const driver = makeBenchDriver("codex");
          const store = yield* EventStore;
          attachSessionTools(commands, sessionTools(store));
          const lead = yield* attachConstellation(leadBinding, "http://127.0.0.1:12345", commands);
          yield* runBenchTurn(lead, repo(root, "G1"), 'bench:{"deltaIntervalMs":0}', driver);

          const call = <A>(
            tools: ReadonlyArray<import("./index.ts").BoundTool>,
            name: string,
            input: A,
            expected?: string
          ) => Effect.promise(() => counter.call(tools, name, input, expected));

          const status = () => commands.status({ kind: "session", sessionId: LEAD }, CID, true);

          const latest = (result: ConstellationResult, id: string) =>
            result.constellation!.attempts.filter((item) => item.taskId === id).at(-1)!;

          yield* call(lead.tools, "plan", {
            start: { name: "M2-style accept loop", workspaceId: WS },
            operations: [
              ...["A1", "A2", "A3"].map((id) =>
                PlanOperation.cases.Add.make({
                  task: new TaskDefinition({
                    id: TaskId.make(id),
                    kind: "task",
                    title: id,
                    brief: `Build ${id}`,
                    area: [`${id}/**`],
                    criteria: ["Claim clean committed work with recorded checks"],
                  }),
                })
              ),
              PlanOperation.cases.Add.make({
                task: new TaskDefinition({
                  id: TaskId.make("G1"),
                  kind: "gate",
                  title: "Integration checks",
                  brief: "Check the accepted result",
                  deps: [TaskId.make("A1"), TaskId.make("A2"), TaskId.make("A3")],
                }),
              }),
            ],
          });
          yield* call(lead.tools, "dispatch", {
            tasks: ["A1", "A2", "A3"].map((id) => ({
              taskId: id,
              worker: { session: `worker-${id}` },
            })),
          });
          yield* call(lead.tools, "status", {});
          yield* call(
            lead.tools,
            "dispatch",
            { tasks: [{ taskId: "G1", worker: { session: "Lead" } }] },
            "E-NOT-READY"
          );
          expect(starts).toHaveLength(3);

          const first = yield* Effect.forEach(starts.splice(0), (attempt) =>
            runAttempt(attempt, commands, driver)
          );

          const a1 = first[0]!;
          const read = yield* call(lead.tools, "read_worker", { task: "A1" });
          expect(read.content[0]?.text).toContain("Task A1 · Attempt");
          expect(read.content[0]?.text).toContain("## Turn 1");
          yield* call(a1.attachment.tools, "progress", {
            note: "Implementation checked",
            completed: 1,
            total: 1,
          });
          yield* call(a1.attachment.tools, "ask", {
            question: {
              id: "cleanup",
              to: "lead",
              text: "Include archive cleanup?",
              blocking: true,
            },
          });
          yield* call(lead.tools, "answer", {
            action: FriendlyAnswer.cases.Question.make({
              task: "worker-A1",
              questionId: "cleanup",
              text: "Yes; add the regression case.",
            }),
          });
          writeFileSync(join(a1.attempt.worktree, "uncommitted.txt"), "unfinished\n");
          yield* call(a1.attachment.tools, "claim", { claim: a1.claim }, "E-CLAIM-DIRTY");
          rmSync(join(a1.attempt.worktree, "uncommitted.txt"));

          for (const worker of first)
            yield* call(worker.attachment.tools, "claim", { claim: worker.claim });
          let current = yield* status();
          expect(current.projections.find((item) => item.taskId === "G1")?.state).toBe("waiting");
          yield* call(
            lead.tools,
            "review",
            {
              task: "A1",
              revision: 99,
              action: ReviewAction.cases.Accept.make({ mergedHead: a1.claim.head, receipts: [] }),
            },
            "E-REVISION"
          );
          yield* call(lead.tools, "review", {
            task: "worker-A1",
            revision: latest(current, "A1").revision,
            action: FriendlyReview.cases.SendBack.make({
              reason: "Add the missing archive cleanup regression.",
              worker: { session: "worker-A1" },
            }),
          });
          yield* call(
            a1.attachment.tools,
            "progress",
            { note: "Old tools cannot update the replacement" },
            "E-REVOKED"
          );
          expect(starts).toHaveLength(1);
          const followup = yield* runAttempt(starts.shift()!, commands, driver);
          expect(followup.attempt.cause).toEqual(
            AttemptCause.cases.SentBack.make({ ref: a1.attempt.id })
          );
          expect(followup.claim.head).not.toBe(a1.claim.head);
          yield* call(followup.attachment.tools, "claim", { claim: followup.claim });

          for (const worker of [followup, first[1]!, first[2]!]) {
            const integration = repo(root, "G1");
            git(integration, "fetch", worker.attempt.worktree, worker.attempt.branch);
            git(integration, "merge", "--allow-unrelated-histories", "--no-edit", "FETCH_HEAD");
            git(integration, "merge-base", "--is-ancestor", worker.claim.head, "HEAD");
            current = yield* status();
            yield* call(lead.tools, "review", {
              task: worker.attempt.taskId,
              revision: latest(current, worker.attempt.taskId).revision,
              action: ReviewAction.cases.Accept.make({
                mergedHead: worker.claim.head,
                receipts: [],
              }),
            });
            const accepted = latest(yield* status(), worker.attempt.taskId);
            expect(accepted.state).toBe("accepted");
            expect(accepted.evidence).toBe("verified");
          }

          current = yield* status();
          expect(current.projections.find((item) => item.taskId === "G1")?.state).toBe("ready");
          yield* call(lead.tools, "dispatch", {
            tasks: [{ taskId: "G1", worker: { session: "Lead" } }],
          });
          const gate = yield* runAttempt(starts.shift()!, commands, driver);
          expect(gate.attempt.sessionId).toBe(LEAD);
          yield* call(gate.attachment.tools, "claim", { claim: gate.claim });
          current = yield* status();
          yield* call(lead.tools, "review", {
            task: "G1",
            revision: latest(current, "G1").revision,
            action: ReviewAction.cases.Accept.make({ mergedHead: gate.claim.head, receipts: [] }),
          });
          yield* call(lead.tools, "set_state", {
            action: SetConstellationStateAction.cases.Complete.make({}),
          });
          yield* call(lead.tools, "status", { json: true });
          current = yield* status();
          expect(current.constellation?.state).toBe("completed");
          expect(current.constellation?.attempts.map((attempt) => attempt.state)).toEqual([
            "rejected",
            "accepted",
            "accepted",
            "accepted",
            "accepted",
          ]);

          const rows = yield* store.readConstellationEvents({
            constellationId: CID,
            after: 0,
            upTo: (yield* store.model).sequence,
          });

          const promotion = rows.findIndex((row) => Predicate.isTagged(row.event, "GatePromoted"));

          const accepts = rows.flatMap((row, index) =>
            Predicate.isTagged(row.event, "AttemptAccepted") &&
            row.event.attemptId !== gate.attempt.id
              ? [index]
              : []
          );

          expect(accepts).toHaveLength(3);
          expect(promotion).toBeGreaterThan(Math.max(...accepts));
          expect(rows.filter((row) => Predicate.isTagged(row.event, "GatePromoted"))).toHaveLength(
            1
          );
          expect(starts).toHaveLength(0);
        })
      ).pipe(Effect.provide(layers))
    );
    expect(counter.stats).toEqual({
      calls: 24,
      errors: 4,
    });
    expect(counter.findings).toEqual(["E-NOT-READY", "E-CLAIM-DIRTY", "E-REVISION", "E-REVOKED"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
