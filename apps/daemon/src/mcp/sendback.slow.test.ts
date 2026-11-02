import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Attempt, type Constellation, type Turn, TurnId } from "@polaris/protocol";
import { Effect } from "effect";
import { CID, LEAD, HOST, report } from "../engine/constellation.testing.ts";
import { setup, finish, send } from "../constellation/delivery/testing.ts";
import { Constellations } from "../constellation/service.ts";
import { EventStore } from "../store/EventStore.ts";
import { startPendingAttempt } from "../constellation/composition/workers.ts";
import { McpBinding } from "./binding.ts";
import { FriendlyReview } from "./tools/inputs.ts";
import { callSendbackTool as call } from "./sendback.tools.testing.ts";
import { sendbackWorld } from "./sendback.testing.ts";
import { recordSendbackTrace } from "./sendback.trace.testing.ts";
import { restartForRetry } from "./sendback.restart.testing.ts";
import { shortTemp } from "../platform/testing.ts";

const reason =
  '  Fix the missing cleanup.\n\nKeep `$(literal)` and Unicode λ and "quoted" feedback verbatim.\n' +
  "Explain the failure and retain both tests.\n".repeat(90) +
  "Trailing spaces stay.  \n";

const lead = McpBinding.cases.Lead.make({ sessionId: LEAD, constellationId: CID });

const worker = (attempt: Attempt) =>
  McpBinding.cases.Worker.make({
    sessionId: attempt.sessionId,
    constellationId: CID,
    attemptId: attempt.id,
  });

const assertTurn = (turn: Turn, previous: Attempt, merge: boolean) => {
  expect(turn.prompt).toContain(`Review feedback:\n${reason}`);
  expect(turn.prompt).toContain(JSON.stringify(previous.claim));
  expect(turn.prompt).toContain(previous.claim!.head);

  if (merge)
    expect(turn.prompt).toStartWith(
      "Merge conflict: merge integration-base into your branch first"
    );
};

for (const fresh of [false, true])
  for (const merge of [false, true]) {
    for (const restart of [false, true]) {
      test(`MCP SendBack delivers verbatim feedback: fresh=${fresh}, merge=${merge}, restart=${restart}`, async () => {
        const root = mkdtempSync(shortTemp("polaris-sendback-"));
        const file = join(root, "state.sqlite");
        const w = sendbackWorld(file, !restart);
        let saved: { graph: Constellation; previous: Attempt; attempt: Attempt };

        try {
          saved = await w.run(
            Effect.gen(function* () {
              yield* setup();
              const commands = yield* Constellations;
              const store = yield* EventStore;
              const initial = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;

              if (!restart) yield* finish(initial.sessionId);

              yield* Effect.promise(() =>
                call(worker(initial), commands, "claim", { claim: report() })
              );
              const previous = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;

              yield* Effect.promise(() =>
                call(lead, commands, "review", {
                  task: "A",
                  revision: previous.revision,
                  action: FriendlyReview.cases.SendBack.make({
                    reason,
                    worker: fresh ? { host: HOST } : { session: initial.sessionId },
                    mergeConflictBase: merge ? "integration-base" : null,
                  }),
                })
              );
              const graph = (yield* store.model).constellations.get(CID)!.graph;
              const attempt = graph.attempts.at(-1)!;

              expect(graph.attempts[0]!.rejectionReason).toBe(reason);

              expect(attempt.sessionId === initial.sessionId).toBe(!fresh);

              for (const binding of [lead, worker(attempt)]) {
                const text = yield* Effect.promise(() =>
                  call(binding, commands, "status", { json: true })
                );

                expect(text).toContain(`Claim ${previous.claim!.head}`);

                expect(text).toContain("  Review feedback:\n    Fix the missing cleanup.");

                expect(text).toContain("    …");

                expect(text).toContain(JSON.stringify(reason));
              }

              const turns = (yield* store.model).sessions.get(attempt.sessionId)!.turns;

              if (restart) expect(turns.some((t) => t.id === `${attempt.id}:start`)).toBe(false);
              else {
                assertTurn(turns.at(-1)!, previous, merge);
                yield* recordSendbackTrace(`${fresh}-${merge}-${restart}`);
              }

              return { graph, previous, attempt };
            })
          );

          if (restart) {
            assertTurn(await restartForRetry(root, saved.attempt), saved.previous, merge);
            const resumed = sendbackWorld(file, true);

            await resumed.run(
              Effect.gen(function* () {
                const store = yield* EventStore;
                const graph = (yield* store.model).constellations.get(CID)!.graph;

                expect(graph.attempts[0]!.rejectionReason).toBe(reason);

                yield* startPendingAttempt(graph, saved.attempt);

                yield* startPendingAttempt(graph, saved.attempt);

                const turns = (yield* store.model).sessions.get(saved.attempt.sessionId)!.turns;

                expect(turns.filter((t) => t.id === `${saved.attempt.id}:start`)).toHaveLength(1);

                assertTurn(turns.at(-1)!, saved.previous, merge);

                expect(resumed.turns).toHaveLength(0);

                yield* recordSendbackTrace(`${fresh}-${merge}-${restart}`);
              })
            );
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }, 20000);
    }
  }

test("Initial Attempt committed before shutdown receives its first Turn on restart", async () => {
  const root = mkdtempSync(shortTemp("polaris-initial-start-"));

  try {
    const w = sendbackWorld(join(root, "state.sqlite"), false);

    const attempt = await w.run(
      Effect.gen(function* () {
        yield* setup();
        const store = yield* EventStore;

        return (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;
      })
    );

    const turn = await restartForRetry(root, attempt);
    expect(turn.id).toBe(TurnId.make(`${attempt.id}:start`));
    expect(turn.prompt).toContain("Polaris assignment");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test("retry restart recovers after its first Turn falls out of the recent 32 Turns", async () => {
  const root = mkdtempSync(shortTemp("polaris-long-retry-"));
  const file = join(root, "state.sqlite");

  try {
    const w = sendbackWorld(file, true);

    const saved = await w.run(
      Effect.gen(function* () {
        yield* setup();
        const commands = yield* Constellations;
        const store = yield* EventStore;
        const initial = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;
        yield* finish(initial.sessionId);
        yield* Effect.promise(() => call(worker(initial), commands, "claim", { claim: report() }));
        const previous = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;
        yield* Effect.promise(() =>
          call(lead, commands, "review", {
            task: "A",
            revision: previous.revision,
            action: FriendlyReview.cases.SendBack.make({
              reason,
              worker: { session: initial.sessionId },
            }),
          })
        );
        const attempt = (yield* store.model).constellations.get(CID)!.graph.attempts.at(-1)!;

        for (let i = 0; i < 34; i++) {
          yield* finish(attempt.sessionId);
          yield* send(attempt.sessionId, `Next step ${i}`);
        }

        const turns = (yield* store.model).sessions.get(attempt.sessionId)!.turns;
        expect(turns).toHaveLength(32);
        expect(turns.some((t) => t.id === `${attempt.id}:start`)).toBe(false);
        expect(
          yield* startPendingAttempt((yield* store.model).constellations.get(CID)!.graph, attempt)
        ).toBe(false);

        return { attempt, index: turns.at(-1)!.index };
      })
    );

    const recovered = await restartForRetry(root, saved.attempt, saved.index);
    expect(recovered.index).toBe(saved.index + 1);
    const resumed = sendbackWorld(file, true);
    await resumed.run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const model = yield* store.model;
        expect(
          yield* startPendingAttempt(model.constellations.get(CID)!.graph, saved.attempt)
        ).toBe(false);

        const all = yield* store.readTurns({
          sessionId: saved.attempt.sessionId,
          beforeIndex: null,
          limit: null,
        });

        expect(all.filter((t) => t.id === `${saved.attempt.id}:start`)).toHaveLength(1);
        expect(model.constellations.get(CID)!.recoveries.size).toBe(1);
        expect(resumed.turns).toHaveLength(0);
      })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
