/**
 * A Reviewer Turn on codex-cli 0.159 (lucas-devbox, 2026-10-01): two supervised
 * Subagents asked for command approvals before the parent reported spawning
 * them. Each request named the Subagent's own Codex turn, which Polaris took
 * for a new Turn: two empty Turns, stuck working, after the real one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApprovalDecision, TurnId } from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import { makeCodexDriver } from "./CodexDriver.ts";
import { cleanup, ofTag, scripted, sessionWith, THREAD, turn } from "./testing/session.ts";

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const withSession = sessionWith(makeCodexDriver);

const T1 = TurnId.make("turn-1");

const CHILD = "child-thread";

const message = (threadId: string, turnId: string, id: string, text: string) => ({
  threadId,
  turnId,
  completedAtMs: 0,
  item: { type: "agentMessage", id, text, phase: "final_answer" },
});

const activity = (id: string, kind: string) => ({
  threadId: THREAD,
  turnId: "t1",
  completedAtMs: 0,
  item: {
    type: "subAgentActivity",
    id,
    kind,
    agentThreadId: CHILD,
    agentPath: "/root/spec_review",
  },
});

describe("Codex Subagents in a supervised Turn", () => {
  test("a Subagent's approval names it and belongs to the Turn that spawned it; its card sits where it was spawned", async () => {
    const handler = scripted((request, conn) => {
      if (request.method !== "turn/start") return;
      conn.reply({ turn: turn("t1") });
      conn.notify("turn/started", { threadId: THREAD, turn: turn("t1") });
      // The Subagent's thread starts, and asks, before the parent reports spawning it.
      conn.notify("turn/started", { threadId: CHILD, turn: turn("ct1") });
      void conn
        .request("item/commandExecution/requestApproval", {
          threadId: CHILD,
          turnId: "ct1",
          itemId: "cmd1",
          startedAtMs: 0,
          kind: "command",
          environmentId: null,
          command: "rg --files",
          cwd: "/repo",
          reason: null,
        })
        .then(() => {
          conn.notify("item/completed", activity("call_spawn", "started"));
          conn.notify("item/completed", message(CHILD, "ct1", "c1", "No findings."));
          conn.notify("turn/completed", { threadId: CHILD, turn: turn("ct1", "completed") });
          conn.notify("item/completed", activity("subagent-completed-1", "completed"));
          conn.notify("item/completed", message(THREAD, "t1", "m1", "I found no regression."));
          conn.notify("item/completed", message(THREAD, "t1", "m2", '{"findings":[]}'));
          conn.notify("turn/completed", { threadId: THREAD, turn: turn("t1", "completed") });
        });
    });

    const { events } = await withSession(handler, ({ session, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn({
          turnId: T1,
          prompt: "review",
          attachments: [],
          model: null,
          effort: null,
        });
        const asked = yield* waitFor("ApprovalRequested");
        yield* session.respond(
          asked.requestId,
          ApprovalDecision.cases.Allow.make({ remember: false })
        );
        yield* waitFor("TurnEnded");
      })
    );

    // One Turn: the one Polaris sent.
    expect(ofTag(events, "TurnStarted").map((e) => e.turnId)).toEqual([T1]);
    expect(ofTag(events, "TurnEnded").map((e) => e.turnId)).toEqual([T1]);
    expect(ofTag(events, "ApprovalRequested")).toMatchObject([{ turnId: T1, subagentId: CHILD }]);

    // The spawn is an item of the Turn, and the Subagent's card hangs from it.
    const started = ofTag(events, "SubagentStarted")[0];
    expect(started).toMatchObject({ turnId: T1, parentItemId: "call_spawn", title: "spec_review" });
    const own = ofTag(events, "ItemCompleted").filter((e) => e.subagentId === undefined);
    expect(own.map((e) => e.item.id)).toEqual(["call_spawn", "m1", "m2"]);
    expect(own[0] !== undefined && Predicate.isTagged(own[0].item, "ToolCall")).toBe(true);
    expect(own[0]?.item).toMatchObject({ name: "agent.spawn" });
    expect(
      own.flatMap((e) => (Predicate.isTagged(e.item, "AssistantMessage") ? [e.item.text] : []))
    ).toEqual(["I found no regression.", '{"findings":[]}']);
  });
});
