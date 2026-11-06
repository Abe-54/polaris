import { expect, test } from "bun:test";
import { SessionId, TurnId } from "@polaris/protocol";
import { Effect } from "effect";
import type { TurnToRun } from "./supervisor.ts";
import { takeDeferredTurn } from "./supervisor.turns.ts";

test("a finished lane's last take can't retire its replacement lane", async () => {
  const sessionId = SessionId.make("lane");

  const input: TurnToRun = {
    sessionId,
    turnId: TurnId.make("original"),
    prompt: "first",
    attachments: [],
  };

  const old = [input];
  const queues = new Map([[sessionId, old]]);
  expect(takeDeferredTurn(queues, sessionId, old)).toBe(input);
  await Effect.runPromise(
    Effect.sync(() => {
      expect(takeDeferredTurn(queues, sessionId, old)).toBeUndefined();
      expect(queues.has(sessionId)).toBe(false);
    }).pipe(Effect.andThen(Effect.yieldNow))
  );
  const arriving = { ...input, prompt: "next" };
  const replacement = queues.get(sessionId) ?? [];
  replacement.push(arriving);
  queues.set(sessionId, replacement);
  // The old fiber can finalize after the replacement lane starts.
  expect(takeDeferredTurn(queues, sessionId, old)).toBeUndefined();
  expect(queues.get(sessionId)).toBe(replacement);
  expect(takeDeferredTurn(queues, sessionId, replacement)).toBe(arriving);
});
