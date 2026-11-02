import { makeFakes, makeFakeDriver } from "../../engine/testing.ts";
import { expect, test } from "bun:test";
import { Command, CommandId, Attempt } from "@polaris/protocol";
import { Effect, Exit, Fiber, Struct } from "effect";
import { Engine } from "../../engine/Engine.ts";
import { CID, WS, draft } from "../../engine/constellation.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { inputQueueWorld } from "./inputQueue.testing.ts";
import { finish, send, setup, wait } from "../delivery/testing.ts";
import { sendbackWorld } from "../../mcp/sendback.testing.ts";
import { recordSendbackTrace } from "../../mcp/sendback.trace.testing.ts";
import { sendBack } from "./sendback.testing.ts";
import { startAttempt } from "./workers.ts";
import { WorktreeSetupService } from "../setup/index.ts";
import { WorktreeSetup } from "@polaris/protocol";
import { tempDir, removeTempDir } from "../../git/testing.ts";

test("queued new prompts keep arrival order and later prompts join behind the active prompt", async () => {
  const { driver, layer } = inputQueueWorld(makeFakes(), makeFakeDriver("codex", { steer: true }));
  await sendbackWorld(":memory:", false).run(
    Effect.gen(function* () {
      yield* setup();
      const engine = yield* Engine;
      const store = yield* EventStore;
      const sid = draft().sessionId;
      yield* send(sid, "Old Turn");
      const old = (yield* store.model).sessions.get(sid)!.turns.at(-1)!;
      yield* engine.runCommittedTurn(old, old.prompt);
      const attempt = yield* sendBack();
      const graph = (yield* store.model).constellations.get(CID)!.graph;

      const submit = (prompt: string) =>
        engine
          .dispatch({
            commandId: CommandId.make(prompt),
            deviceLabel: "test",
            command: Command.cases.SendTurn.make({ sessionId: sid, prompt, attachments: [] }),
          })
          .pipe(Effect.forkChild);

      const first = yield* submit("First prompt");
      yield* Effect.yieldNow;
      const second = yield* submit("Second prompt");
      const startup = yield* startAttempt(graph, attempt).pipe(Effect.forkChild);
      yield* finish(sid);
      yield* Fiber.join(startup);
      expect(driver.latest(sid)!.turns).toHaveLength(1);
      yield* finish(sid);
      yield* Fiber.join(first);
      yield* wait(() => Effect.succeed(driver.latest(sid)!.turns.length === 2));
      const third = yield* submit("Third prompt");
      yield* Effect.yieldNow;
      expect(driver.latest(sid)!.turns).toHaveLength(2);
      yield* finish(sid);
      yield* Fiber.join(second);
      yield* wait(() => Effect.succeed(driver.latest(sid)!.turns.length === 3));
      yield* finish(sid);
      yield* Fiber.join(third);
      yield* wait(() => Effect.succeed(driver.latest(sid)!.turns.length === 4));
      expect(
        driver
          .latest(sid)!
          .turns.slice(1)
          .map((t) => t.prompt)
      ).toEqual(["First prompt", "Second prompt", "Third prompt"]);
      yield* recordSendbackTrace("fifo-prompts");
    }).pipe(Effect.provide(layer))
  );
}, 15000);

for (const command of ["exit 7", "mkdir package.json"])
  test(`setup failure clears startup fence for input and Retry: ${command}`, async () => {
    const root = tempDir();

    const { driver, layer } = inputQueueWorld(
      makeFakes(),
      makeFakeDriver("codex", { steer: true })
    );

    try {
      await sendbackWorld(":memory:", false).run(
        Effect.gen(function* () {
          yield* setup();
          const store = yield* EventStore;
          const engine = yield* Engine;
          const sid = draft().sessionId;
          yield* send(sid, "Old Turn");
          const old = (yield* store.model).sessions.get(sid)!.turns.at(-1)!;
          yield* engine.runCommittedTurn(old, old.prompt);
          const attempt = yield* sendBack();
          const graph = (yield* store.model).constellations.get(CID)!.graph;

          const retry = Attempt.make(
            Struct.assign(attempt, { worktree: root, startupSetup: { command, force: true } })
          );

          const startup = yield* startAttempt(graph, retry).pipe(Effect.exit, Effect.forkChild);

          const prompt = yield* engine
            .dispatch({
              commandId: CommandId.make("waiting-prompt"),
              deviceLabel: "test",
              command: Command.cases.SendTurn.make({
                sessionId: sid,
                prompt: "After failed setup",
                attachments: [],
              }),
            })
            .pipe(Effect.exit, Effect.forkChild);

          yield* finish(sid);
          yield* Fiber.join(startup);
          expect((yield* store.model).sessions.get(sid)!.session.worktreeSetup?.status).toBe(
            "failed"
          );
          expect(Exit.isSuccess(yield* Fiber.join(prompt))).toBe(true);
          yield* wait(() => Effect.succeed(driver.latest(sid)!.turns.length === 2));
          yield* finish(sid, "failed");
          yield* (yield* WorktreeSetupService).run(
            sid,
            "manual-repair",
            root,
            WorktreeSetup.cases.Command.make({
              command: command === "exit 7" ? "exit 0" : "rmdir package.json",
            }),
            CID,
            attempt.taskId,
            WS
          );
          expect((yield* store.model).sessions.get(sid)!.session.worktreeSetup?.status).toBe(
            "completed"
          );
          expect(
            yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:startup-failed`))
          ).toBe(true);
          // Retry must reach the Session decider even if setup failed before a brief receipt.

          const result = yield* engine
            .dispatch({
              commandId: CommandId.make("after-failure-retry"),
              deviceLabel: "test",
              command: Command.cases.Retry.make({ sessionId: sid }),
            })
            .pipe(Effect.exit);

          expect(Exit.isSuccess(result)).toBe(true);
          yield* wait(() => Effect.succeed(driver.latest(sid)!.turns.length === 3));
          expect(driver.latest(sid)!.turns[2]!.prompt).toBe("After failed setup");
          expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(false);
          expect(driver.latest(sid)!.turns.every((t) => t.turnId !== `${attempt.id}:start`)).toBe(
            true
          );
        }).pipe(Effect.provide(layer))
      );
    } finally {
      removeTempDir(root);
    }
  }, 15000);
