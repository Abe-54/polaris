import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Command, ReviewerChoice, ReviewSubject, SessionId } from "@polaris/protocol";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Engine } from "../engine/Engine.ts";
import {
  cid,
  fakeRepo,
  engineLayer,
  makeFakeDriver,
  makeFakes,
  tempDir,
} from "../engine/testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { ReviewerPolicyLive } from "./index.ts";
import { recoverReviewer } from "./recovery.ts";
import { startReviewerSession, TURN_TIMEOUT } from "./session.ts";
import { ReviewerSessions } from "./sessions.ts";

const dirs: Array<string> = [];

const subject = ReviewSubject.cases.SessionTurns.make({
  sessionId: SessionId.make("ses_reviewed"),
  firstTurnId: null,
  lastTurnId: null,
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

test("an unfinished Reviewer times out, interrupts its Turn, and retains its no-prompt identity after restart", async () => {
  const dir = tempDir();
  const repo = fakeRepo();
  dirs.push(dir, repo);
  const driver = makeFakeDriver("codex");
  const filename = join(dir, "state.sqlite");

  const engine = engineLayer({ filename, fakes: makeFakes(), drivers: [driver] }).pipe(
    Layer.provide(ReviewerPolicyLive),
    Layer.provideMerge(ReviewerSessions.layer)
  );

  const reviewerId = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* Engine;
      const store = yield* EventStore;
      yield* engine.dispatch({
        commandId: cid(),
        deviceLabel: "test",
        command: Command.cases.RegisterWorkspace.make({ path: repo, name: null }),
      });
      const workspace = [...(yield* store.model).workspaces.values()][0]!;

      const fiber = yield* startReviewerSession({
        workspaceId: workspace.id,
        checkoutId: null,
        choice: ReviewerChoice.make({ harness: "codex", model: "gpt-6.1-sol", effort: "high" }),
        title: "Reviewer",
        subject,
        prompt: "<!-- polaris:reviewer -->\nreview",
      }).pipe(Effect.flip, Effect.forkChild);

      yield* Effect.promise(async () => {
        for (let i = 0; i < 200 && driver.sessions[0]?.turns.length !== 1; i++) await Bun.sleep(5);

        if (driver.sessions[0]?.turns.length !== 1) throw new Error("Reviewer didn't start");
      });
      yield* TestClock.adjust(TURN_TIMEOUT);
      expect((yield* Fiber.join(fiber)).message).toBe(
        "The Reviewer took too long and was stopped."
      );
      yield* Effect.promise(async () => {
        for (let i = 0; i < 200 && driver.sessions[0]?.interrupts !== 1; i++) await Bun.sleep(5);
      });
      expect(driver.sessions[0]?.interrupts).toBe(1);
      const id = driver.sessions[0]!.options.sessionId;
      expect((yield* store.model).sessions.get(id)?.session.origin).toBe("reviewer");
      expect((yield* store.model).sessions.get(id)?.session.reviewSubject).toEqual(subject);

      return driver.sessions[0]!.options.sessionId;
    }).pipe(Effect.provide(engine), Effect.provide(TestClock.layer()))
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* recoverReviewer;
      expect((yield* ReviewerSessions).has(reviewerId)).toBe(true);
    }).pipe(
      Effect.provide(Layer.mergeAll(EventStore.layerSqlite(filename), ReviewerSessions.layer))
    )
  );
});
