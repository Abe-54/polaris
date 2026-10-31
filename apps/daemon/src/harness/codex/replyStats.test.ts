import { afterEach, expect, test } from "bun:test";
import { TurnId, TurnItem } from "@polaris/protocol";
import { Effect } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import { cleanup, scripted, sessionWith, THREAD, turn } from "./testing/session.ts";

const withSession = sessionWith(makeCodexDriver);

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const breakdown = (outputTokens: number) => ({
  totalTokens: 20_000 + outputTokens,
  inputTokens: 20_000,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens,
  reasoningOutputTokens: 0,
});

const userMessage = {
  type: "userMessage",
  id: "u1",
  clientId: null,
  content: [{ type: "text", text: "hi", text_elements: [] }],
};

const agentMessage = {
  type: "agentMessage",
  id: "m1",
  text: "Hello.",
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
};

test("a reply completes again with its call's tokens, timed from the request it answered", async () => {
  const sent = Date.now() - 3_000;

  const handler = scripted((request, conn) => {
    if (request.method !== "turn/start") return;
    const item = { threadId: THREAD, turnId: "t1" };
    conn.reply({ turn: turn("t1") });
    conn.notify("turn/started", { threadId: THREAD, turn: turn("t1") });
    conn.notify("item/started", { ...item, startedAtMs: sent, item: userMessage });
    conn.notify("item/completed", { ...item, completedAtMs: sent, item: userMessage });
    conn.notify("item/started", { ...item, startedAtMs: sent + 800, item: agentMessage });
    conn.notify("item/completed", { ...item, completedAtMs: sent + 900, item: agentMessage });
    conn.notify("thread/tokenUsage/updated", {
      ...item,
      tokenUsage: { total: breakdown(120), last: breakdown(120), modelContextWindow: null },
    });
    conn.notify("turn/completed", { threadId: THREAD, turn: turn("t1", "completed") });
  });

  const { events } = await withSession(handler, ({ session, waitFor }) =>
    Effect.gen(function* () {
      yield* session.sendTurn({
        turnId: TurnId.make("turn-1"),
        prompt: "hi",
        attachments: [],
        model: null,
        effort: null,
      });
      yield* waitFor("TurnEnded");
    })
  );

  const replies = events
    .filter(HarnessEvent.$is("ItemCompleted"))
    .flatMap((e) => (TurnItem.guards.AssistantMessage(e.item) ? [e.item] : []));

  expect(replies.map((r) => r.stats?.outputTokens ?? null)).toEqual([null, 120]);
  expect(replies[1]?.stats?.latencyMs).toBe(800);
  // Generation runs from the first token until the usage arrived, on this Host's clock.
  expect(replies[1]?.stats?.durationMs).toBeGreaterThanOrEqual(2_200);
});
