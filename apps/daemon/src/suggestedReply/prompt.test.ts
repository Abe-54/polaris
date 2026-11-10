import { expect, test } from "bun:test";
import { TurnItem } from "@polaris/protocol";
import { replyPrompt, replyText } from "./prompt.ts";
import { turn } from "./testing.ts";

const say = (id: string, text: string) => TurnItem.cases.AssistantMessage.make({ id, text });

test("each Turn reads as its prompt, its steers and only the agent's final text", () => {
  const items = new Map([
    [
      turn(1).id,
      [
        say("a", "Looking at the tests"),
        TurnItem.cases.UserMessage.make({ id: "u", text: "skip the e2e ones" }),
        say("b", "Done; shall I push?"),
      ],
    ],
  ]);

  const prompt = replyPrompt([turn(1, "completed", "fix the tests")], items);

  expect(prompt).toContain(
    "User: fix the tests\n\nUser: skip the e2e ones\n\nAgent: Done; shall I push?"
  );
  expect(prompt).not.toContain("Looking at the tests");
});

test("only the last 3 Turns, oldest first", () => {
  const prompt = replyPrompt(
    [0, 1, 2, 3].map((index) => turn(index)),
    new Map()
  );

  expect(prompt).not.toContain("ask 0");
  expect(prompt.indexOf("ask 1")).toBeLessThan(prompt.indexOf("ask 3"));
});

test("over budget, older Turns go first and the oldest kept loses its start", () => {
  const items = new Map([
    [turn(0).id, [say("0", "OLDEST".repeat(100))]],
    [turn(1).id, [say("1", `${"y".repeat(200)}TAIL`)]],
    [turn(2).id, [say("2", "newest answer")]],
  ]);

  const prompt = replyPrompt([turn(0), turn(1), turn(2)], items, 150);

  expect(prompt).not.toContain("OLDEST");
  expect(prompt).toContain("[earlier text cut]");
  expect(prompt).toContain("TAIL");
  expect(prompt).not.toContain("ask 1");
  expect(prompt).toContain("User: ask 2\n\nAgent: newest answer");
});

test("a null or blank reply is nothing to offer", () => {
  expect(replyText({ reply: null })).toBeNull();
  expect(replyText({ reply: "  \n" })).toBeNull();
  expect(replyText({ reply: " Ship it. " })).toBe("Ship it.");
});

test.each(["null", "NULL", '"null"', "None.", "nothing"])(
  "a model's word for no reply (%s) is nothing to offer",
  (reply) => expect(replyText({ reply })).toBeNull()
);

test("inline code marks are dropped from a reply", () => {
  expect(replyText({ reply: "B: `hasPendingRetry`" })).toBe("B: hasPendingRetry");
  expect(replyText({ reply: "Null checks first, please" })).toBe("Null checks first, please");
});
