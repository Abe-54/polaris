import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TurnId, TurnItem } from "@polaris/protocol";
import { HarnessEvent } from "../HarnessDriver.ts";
import { ClaudeTranslator } from "./translate.ts";

/** A frame as the SDK sends it: a fixture's line, or one built below in the SDK's wire shape. */
const recorded = (line: string): SDKMessage => {
  // SAFETY: every line is an SDK message, recorded or built in its wire shape.
  const frame = JSON.parse(line) as SDKMessage;

  return frame;
};

/** A translator on a clock the test sets before each frame. */
const harness = () => {
  let ms = 0;
  const translator = new ClaudeTranslator("/repo", null, () => new Date(ms).toISOString());

  return {
    translator,
    at: (time: number, line: string) => {
      ms = time;

      return translator.onMessage(recorded(line));
    },
  };
};

/** A stream event's frame, from the event's own JSON. */
const stream = (event: string) =>
  `{"type":"stream_event","parent_tool_use_id":null,"event":${event}}`;

const start = (id: string) => stream(JSON.stringify({ type: "message_start", message: { id } }));

const delta = stream(
  JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Do" },
  })
);

const end = (outputTokens: number) =>
  stream(
    JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: outputTokens } })
  );

const textBlock = (text: string) => JSON.stringify([{ type: "text", text }]);

const toolUse = (id: string) => JSON.stringify([{ type: "tool_use", id, name: "Read", input: {} }]);

/** An assistant frame, from its content blocks' JSON. */
const assistant = (id: string, content: string) =>
  `{"type":"assistant","parent_tool_use_id":null,"message":{"id":"${id}","content":${content},"usage":{"input_tokens":1,"output_tokens":1}}}`;

const toolResult = (id: string) =>
  JSON.stringify({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });

const replies = (events: ReadonlyArray<HarnessEvent>) =>
  events.filter(HarnessEvent.$is("ItemCompleted")).flatMap((e) => {
    const { item } = e;

    return TurnItem.guards.AssistantMessage(item) ? [item] : [];
  });

describe("reply stats", () => {
  test("a reply completes again with its call's tokens, latency and generation time", () => {
    const { translator, at } = harness();
    translator.beginTurn(TurnId.make("t"));

    at(1_000, start("m1"));
    at(1_500, delta);
    const first = replies(at(3_000, assistant("m1", textBlock("Done."))));
    const again = replies(at(3_500, end(100)));

    expect(first).toMatchObject([{ id: "m1:0", stats: null }]);
    expect(again).toMatchObject([
      {
        id: "m1:0",
        text: "Done.",
        stats: { outputTokens: 100, latencyMs: 1_500, durationMs: 2_000 },
      },
    ]);
  });

  test("a call after tool results is timed from them; one without a seen request has no latency", () => {
    const { translator, at } = harness();
    translator.beginTurn(TurnId.make("t"));

    at(0, start("m1"));
    at(100, delta);
    at(200, assistant("m1", toolUse("tool1")));
    at(300, end(10));
    at(5_000, toolResult("tool1"));
    at(5_100, start("m2"));
    at(5_400, delta);
    at(5_500, assistant("m2", textBlock("Read it.")));
    const afterTool = replies(at(6_400, end(50)));

    at(7_000, start("m3"));
    at(7_200, delta);
    at(7_300, assistant("m3", textBlock("Again.")));
    const unseen = replies(at(7_400, end(5)));

    expect(afterTool[0]?.stats).toMatchObject({ latencyMs: 400, durationMs: 1_000 });
    expect(unseen[0]?.stats).toMatchObject({ outputTokens: 5, latencyMs: null, durationMs: 200 });
  });

  test("a recorded Turn's final reply carries its call's output tokens", () => {
    const frames = readFileSync(join(import.meta.dir, "fixtures", "subagent-turn.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(recorded);

    const translator = new ClaudeTranslator("/repo", null, () => "2026-10-01T00:00:00.000Z");
    translator.beginTurn(TurnId.make("t"));
    const events = frames.flatMap((frame) => translator.onMessage(frame));
    const own = replies(events.filter((e) => !("subagentId" in e) || e.subagentId === undefined));

    expect(own.at(-1)?.stats?.outputTokens).toBe(133);
  });
});
