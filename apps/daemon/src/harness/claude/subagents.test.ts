import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionId, SubagentId, TurnId, TurnItem, TurnTrigger } from "@polaris/protocol";
import { Effect, Exit, Scope, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import {
  assistant,
  FakeClaude,
  inSubagent,
  result,
  taskNotification,
  taskStarted,
  toolResult,
} from "./fakeClaude.ts";

const T1 = TurnId.make("turn-1");

const AGENT = "toolu_agent";

const SUB = SubagentId.make(AGENT);

/** A Claude session on the fake, with one Turn sent; `events` collects what the driver emits. */
const openWithTurn = async () => {
  const fake = new FakeClaude();
  const scope = Effect.runSync(Scope.make());

  const session = await Effect.runPromise(
    makeClaudeDriver({ query: fake.query, claudePath: () => "/opt/bin/claude" })
      .open({
        sessionId: SessionId.make("s1"),
        cwd: "/work",
        permissionMode: "full-access",
        model: null,
        effort: null,
        resumeCursor: null,
      })
      .pipe(Scope.provide(scope))
  );

  const events: HarnessEvent[] = [];
  Effect.runFork(Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e))));
  await Effect.runPromise(
    session.sendTurn({ turnId: T1, prompt: "go", attachments: [], model: null, effort: null })
  );
  const uuid = (await fake.nextInput(0)).uuid!;

  // Until the events stop arriving for 20 ms: a loaded CI runner delivers them late.
  const settle = async () => {
    await fake.waitProcessed();

    for (let quiet = 0, seen = -1, waited = 0; quiet < 4 && waited < 1000; waited += 5) {
      quiet = events.length === seen ? quiet + 1 : 0;
      seen = events.length;
      await Bun.sleep(5);
    }
  };

  /** What the driver emitted, as `tag subagent? detail`, without the Turn's start. */
  const trace = () =>
    events.flatMap((e) => {
      if (
        HarnessEvent.$is("TurnStarted")(e) ||
        HarnessEvent.$is("CursorAssigned")(e) ||
        HarnessEvent.$is("BackgroundTasksChanged")(e)
      )
        return [];
      const sub = "subagentId" in e && e.subagentId !== undefined ? `[${e.subagentId}] ` : "";
      const item = "item" in e ? `${e.item._tag}:${"status" in e.item ? e.item.status : "-"}` : "";
      const status = HarnessEvent.$is("SubagentEnded")(e) ? e.status : "";

      return [`${e._tag} ${sub}${item}${status}`.trim()];
    });

  return {
    fake,
    session,
    events,
    trace,
    settle,
    uuid,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

const agentCall = (background: boolean) =>
  assistant("m1", [
    {
      type: "tool_use",
      id: AGENT,
      name: "Agent",
      input: {
        description: "Check frame timing",
        prompt: "Measure it",
        subagent_type: "Explore",
        model: "haiku",
        run_in_background: background,
      },
    },
  ]);

describe("Claude Subagents", () => {
  test("a foreground Agent call is a Subagent with its own items, ending with the call", async () => {
    const t = await openWithTurn();
    t.fake.emit(agentCall(false));
    t.fake.emit(taskStarted(AGENT, "Check frame timing", { subagentType: "Explore" }));
    t.fake.emit(inSubagent(AGENT, assistant("sub-1", [{ type: "text", text: "Measuring" }])));
    t.fake.emit(
      inSubagent(
        AGENT,
        assistant("sub-2", [
          { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } },
        ])
      )
    );
    t.fake.emit(inSubagent(AGENT, toolResult("toolu_bash", "a.txt")));
    t.fake.emit(toolResult(AGENT, "Timing is fine"));
    t.fake.emit(result([t.uuid]));
    await t.settle();

    expect(t.trace()).toEqual([
      "ItemUpdated ToolCall:running",
      `SubagentStarted [${SUB}]`,
      `ItemCompleted [${SUB}] AssistantMessage:-`,
      `ItemUpdated [${SUB}] CommandExecution:running`,
      `ItemCompleted [${SUB}] CommandExecution:completed`,
      "ItemCompleted ToolCall:completed",
      `SubagentEnded [${SUB}] completed`,
      "TurnEnded",
    ]);

    expect(t.events.find(HarnessEvent.$is("SubagentStarted"))).toMatchObject({
      turnId: T1,
      subagentId: SUB,
      parentItemId: AGENT,
      title: "Check frame timing",
      agent: "Explore",
      model: "haiku",
    });
    expect(t.fake.options?.forwardSubagentText).toBe(true);
    await t.close();
  });

  test("a background Subagent outlives its Turn and ends with its notification", async () => {
    const t = await openWithTurn();
    t.fake.emit(agentCall(true));
    t.fake.emit(taskStarted(AGENT, "Check frame timing", { background: true }));
    t.fake.emit(toolResult(AGENT, "Running in the background"));
    t.fake.emit(result([t.uuid]));
    await t.settle();
    // After the Turn: its frames still belong to it, and the notification ends it.
    t.fake.emit(inSubagent(AGENT, assistant("sub-1", [{ type: "text", text: "Done" }])));
    t.fake.emit(taskNotification(AGENT, "completed"));
    await t.settle();

    expect(t.trace()).toEqual([
      "ItemUpdated ToolCall:running",
      `SubagentStarted [${SUB}]`,
      "ItemCompleted ToolCall:completed",
      "TurnEnded",
      `ItemCompleted [${SUB}] AssistantMessage:-`,
      `SubagentEnded [${SUB}] completed`,
    ]);
    await t.close();
  });

  test("a stopped Subagent is interrupted and its open tool calls are declined", async () => {
    const t = await openWithTurn();
    t.fake.emit(agentCall(true));
    t.fake.emit(taskStarted(AGENT, "Check frame timing", { background: true }));
    t.fake.emit(
      inSubagent(
        AGENT,
        assistant("sub-1", [
          { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "sleep 9" } },
        ])
      )
    );
    t.fake.emit(taskNotification(AGENT, "stopped"));
    await t.settle();

    expect(t.trace().slice(2)).toEqual([
      `ItemUpdated [${SUB}] CommandExecution:running`,
      `ItemCompleted [${SUB}] CommandExecution:declined`,
      `SubagentEnded [${SUB}] interrupted`,
    ]);
    await t.close();
  });

  test("frames and notifications for Subagents it never saw start are ignored", async () => {
    const t = await openWithTurn();
    // No Agent call behind this task, and a frame from an unknown parent.
    t.fake.emit(taskStarted("toolu_other", "Unrelated"));
    t.fake.emit(inSubagent("toolu_other", assistant("x", [{ type: "text", text: "?" }])));
    t.fake.emit(taskNotification("toolu_other", "completed"));
    await t.settle();

    expect(t.trace()).toEqual([]);
    await t.close();
  });
});

test("real background CLI output records a second Turn without sending input", async () => {
  const t = await openWithTurn();

  try {
    // SAFETY: these are scrubbed SDK frames from the real CLI recording.
    const frames = readFileSync(join(import.meta.dir, "fixtures/background-turn.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SDKMessage);

    for (const frame of frames) {
      t.fake.emit(
        frame.type === "result" && frame.origin?.kind !== "task-notification"
          ? { ...frame, user_message_uuid: t.uuid, user_message_uuids: [t.uuid] }
          : frame
      );
    }

    const deadline = Date.now() + 2000;

    while (t.events.filter(HarnessEvent.$is("TurnEnded")).length < 2 && Date.now() < deadline)
      await t.settle();
    const starts = t.events.filter(HarnessEvent.$is("TurnStarted"));
    const ends = t.events.filter(HarnessEvent.$is("TurnEnded"));
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({
      prompt: null,
      trigger: TurnTrigger.cases.BackgroundTasksReported.make({
        tasks: [{ id: "fixture-task-1", kind: "subagent" }],
      }),
    });
    expect(ends.map((e) => e.turnId)).toEqual(starts.map((e) => e.turnId));
    expect(t.events.find(HarnessEvent.$is("SubagentStarted"))).toMatchObject({ background: true });
    expect(t.events.find(HarnessEvent.$is("SubagentEnded"))).toMatchObject({
      report: "**background pong**",
    });

    const messages = t.events
      .filter(HarnessEvent.$is("ItemCompleted"))
      .filter((e) => e.turnId === starts[1]?.turnId && TurnItem.guards.AssistantMessage(e.item));

    expect(JSON.stringify(messages)).toContain("continuation pong");
    expect(t.fake.inputs).toHaveLength(1);
  } finally {
    await t.close();
  }
});

test("a real SubagentHandback input supplies the report instead of the interim text", async () => {
  const t = await openWithTurn();

  try {
    // SAFETY: this block is extracted from a real Claude transcript; the input is decoded by the translator.
    const handback = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures/subagent-handback.json"), "utf8")
    ) as { type: string; id: string; name: string; input: { message: string } };

    t.fake.emit(agentCall(true));
    t.fake.emit(taskStarted(AGENT, "Research", { background: true }));
    t.fake.emit(toolResult(AGENT, "Running in the background"));
    t.fake.emit(result([t.uuid]));
    t.fake.emit(
      inSubagent(AGENT, assistant("interim", [{ type: "text", text: "Now the MCP tools." }]))
    );
    t.fake.emit(inSubagent(AGENT, assistant("handback", [handback])));
    t.fake.emit(taskNotification(AGENT, "completed"));
    await t.settle();
    expect(t.events.find(HarnessEvent.$is("SubagentEnded"))).toMatchObject({
      report: handback.input.message,
    });
  } finally {
    await t.close();
  }
});

test("notifications coalesce only when the parent actually continues", async () => {
  const t = await openWithTurn();

  try {
    t.fake.emit(agentCall(true));
    t.fake.emit(taskStarted(AGENT, "One", { background: true }));
    t.fake.emit(assistant("m2", [{ type: "tool_use", id: "agent2", name: "Agent", input: {} }]));
    t.fake.emit(taskStarted("agent2", "Two", { background: true }));
    t.fake.emit(toolResult(AGENT, "launched"));
    t.fake.emit(toolResult("agent2", "launched"));
    t.fake.emit(result([t.uuid]));
    t.fake.emit(taskNotification(AGENT, "completed"));
    t.fake.emit(taskNotification(AGENT, "completed"));
    t.fake.emit(taskNotification("unrelated-bash", "completed"));
    t.fake.emit(taskNotification("agent2", "failed"));
    await t.settle();
    expect(t.events.filter(HarnessEvent.$is("TurnStarted"))).toHaveLength(1);
    t.fake.emit(assistant("continued", [{ type: "text", text: "Reports received" }]));
    t.fake.emit(result(null));
    await t.settle();
    const starts = t.events.filter(HarnessEvent.$is("TurnStarted"));
    expect(starts).toHaveLength(2);
    expect(starts[1]?.trigger).toEqual(
      TurnTrigger.cases.BackgroundTasksReported.make({
        tasks: [
          { id: `task-${AGENT}`, kind: "subagent" },
          { id: "task-agent2", kind: "subagent" },
        ],
      })
    );
    expect(t.events.filter(HarnessEvent.$is("SubagentEnded"))).toHaveLength(2);
  } finally {
    await t.close();
  }
});

test("a notification result without UUIDs cannot consume a new user prompt", async () => {
  const t = await openWithTurn();

  try {
    t.fake.emit(agentCall(true));
    t.fake.emit(taskStarted(AGENT, "One", { background: true }));
    t.fake.emit(toolResult(AGENT, "launched"));
    t.fake.emit(result([t.uuid]));
    await t.settle();
    t.fake.emit(taskNotification(AGENT, "completed"));
    await t.settle();
    await Effect.runPromise(
      t.session.sendTurn({
        turnId: TurnId.make("t2"),
        prompt: "new user prompt",
        attachments: [],
        model: null,
        effort: null,
      })
    );
    const uuid = (await t.fake.nextInput(1)).uuid!;
    t.fake.emit(assistant("auto", [{ type: "text", text: "Already reported" }]));
    t.fake.emit({ ...result(null), origin: { kind: "task-notification" } });
    await t.settle();
    expect(t.events.filter(HarnessEvent.$is("TurnStarted"))).toHaveLength(2);
    expect(t.events.filter(HarnessEvent.$is("TurnEnded"))).toHaveLength(1);
    t.fake.emit(result([uuid]));
    await t.settle();
    expect(t.events.filter(HarnessEvent.$is("TurnEnded"))).toHaveLength(2);
  } finally {
    await t.close();
  }
});

test("a parent request starts the continuation even when the API fails before assistant output", async () => {
  const t = await openWithTurn();

  try {
    t.fake.emit(agentCall(true));
    t.fake.emit(taskStarted(AGENT, "One", { background: true }));
    t.fake.emit(toolResult(AGENT, "launched"));
    t.fake.emit(result([t.uuid]));
    t.fake.emit(taskNotification(AGENT, "completed"));
    t.fake.emit({
      type: "system",
      subtype: "status",
      status: "requesting",
      uuid: crypto.randomUUID(),
      session_id: "s",
    });
    t.fake.emit({
      ...result(null, { subtype: "error_during_execution", errors: ["API unavailable"] }),
      origin: { kind: "task-notification" },
    });
    const deadline = Date.now() + 2000;

    while (t.events.filter(HarnessEvent.$is("TurnEnded")).length < 2 && Date.now() < deadline)
      await t.settle();

    expect(t.events.filter(HarnessEvent.$is("TurnStarted"))).toHaveLength(2);
    expect(t.events.filter(HarnessEvent.$is("TurnEnded")).at(-1)).toMatchObject({
      status: "failed",
      error: "API unavailable",
    });
  } finally {
    await t.close();
  }
});

test("real background Bash output waits on a command and records its autonomous Turn", async () => {
  const t = await openWithTurn();

  try {
    // SAFETY: scrubbed frames captured from the real CLI background Bash spike.
    const frames = readFileSync(join(import.meta.dir, "fixtures/background-command.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SDKMessage);

    for (const frame of frames)
      t.fake.emit(
        frame.type === "result" && frame.origin?.kind !== "task-notification"
          ? { ...frame, user_message_uuid: t.uuid, user_message_uuids: [t.uuid] }
          : frame
      );
    await t.settle();
    const lists = t.events.filter(HarnessEvent.$is("BackgroundTasksChanged"));
    expect(lists.map((e) => e.tasks)).toEqual([
      [{ id: "fixture-task-3", kind: "command", description: "Sleep for 12 seconds" }],
      [],
    ]);
    const starts = t.events.filter(HarnessEvent.$is("TurnStarted"));
    expect(starts).toHaveLength(2);
    expect(starts[1]?.trigger).toEqual(
      TurnTrigger.cases.BackgroundTasksReported.make({
        tasks: [{ id: "fixture-task-3", kind: "command" }],
      })
    );
    expect(t.events.filter(HarnessEvent.$is("TurnEnded"))).toHaveLength(2);
    expect(t.events.filter(HarnessEvent.$is("SubagentStarted"))).toHaveLength(0);
    expect(JSON.stringify(t.events.filter(HarnessEvent.$is("ItemCompleted")))).toContain(
      "command continuation pong"
    );
    expect(t.fake.inputs).toHaveLength(1);
  } finally {
    await t.close();
  }
});

test("reports arriving during a user Turn survive until the CLI's next parent run", async () => {
  const t = await openWithTurn();

  try {
    // SAFETY: minimized real Bash recording, with user-result UUIDs replaced for this run.
    const frames = readFileSync(join(import.meta.dir, "fixtures/background-command.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SDKMessage);

    const initialResult = frames.findIndex((frame) => frame.type === "result");

    const notice = frames.findIndex(
      (frame) => frame.type === "system" && frame.subtype === "task_notification"
    );

    for (const frame of frames.slice(0, initialResult)) t.fake.emit(frame);
    t.fake.emit(frames[notice]!);
    t.fake.emit(assistant("user-reply", [{ type: "text", text: "Finishing the user's request." }]));
    t.fake.emit(result([t.uuid]));

    for (const frame of frames.slice(notice + 1)) t.fake.emit(frame);
    await t.settle();
    const starts = t.events.filter(HarnessEvent.$is("TurnStarted"));
    expect(starts).toHaveLength(2);
    expect(starts[1]?.trigger).toMatchObject({ tasks: [{ kind: "command" }] });
    expect(
      t.events
        .filter(HarnessEvent.$is("ItemCompleted"))
        .some(
          (event) =>
            event.turnId === starts[1]?.turnId && TurnItem.guards.AssistantMessage(event.item)
        )
    ).toBe(true);
    expect(t.events.filter(HarnessEvent.$is("TurnEnded"))).toHaveLength(2);
  } finally {
    await t.close();
  }
});

test("a parent run without a task edge still starts an autonomous Turn", async () => {
  const t = await openWithTurn();

  try {
    t.fake.emit(result([t.uuid]));
    t.fake.emit(assistant("native", [{ type: "text", text: "Continued." }]));
    t.fake.emit(result([]));
    await t.settle();
    expect(t.events.filter(HarnessEvent.$is("TurnStarted"))).toHaveLength(2);
    expect(t.events.filter(HarnessEvent.$is("ItemCompleted"))).toMatchObject([
      { item: { text: "Continued." } },
    ]);
  } finally {
    await t.close();
  }
});

test("a user prompt racing an autonomous Turn steers it and keeps it open for the user result", async () => {
  const t = await openWithTurn();

  try {
    t.fake.emit(result([t.uuid]));
    t.fake.emit(assistant("native", [{ type: "text", text: "Continuing." }]));
    await t.settle();
    await Effect.runPromise(
      t.session.sendTurn({
        turnId: TurnId.make("racing-user"),
        prompt: "Also check this",
        attachments: [],
        model: null,
        effort: null,
      })
    );
    const input = await t.fake.nextInput(1);
    const auto = t.events.filter(HarnessEvent.$is("TurnStarted"))[1]!;
    t.fake.emit({ ...result([]), origin: { kind: "task-notification" } });
    await t.settle();
    expect(t.events.filter(HarnessEvent.$is("TurnEnded"))).toHaveLength(1);
    t.fake.emit(result([input.uuid!]));
    await t.settle();
    expect(t.events.filter(HarnessEvent.$is("TurnStarted"))).toHaveLength(2);
    expect(
      t.events.find(
        (event) =>
          HarnessEvent.$is("ItemCompleted")(event) && TurnItem.guards.UserMessage(event.item)
      )
    ).toMatchObject({ turnId: auto.turnId, item: { text: "Also check this" } });
    expect(t.events.filter(HarnessEvent.$is("TurnEnded"))[1]?.turnId).toBe(auto.turnId);
  } finally {
    await t.close();
  }
});

test("a continued autonomous Turn still accepts its user's next prompt as a steer", async () => {
  const t = await openWithTurn();

  try {
    t.fake.emit(result([t.uuid]));
    t.fake.emit(assistant("native", [{ type: "text", text: "Continuing." }]));
    await t.settle();
    const auto = t.events.filter(HarnessEvent.$is("TurnStarted"))[1]!;
    await Effect.runPromise(t.session.interrupt);
    t.fake.emit(result([]));
    await t.settle();
    await Effect.runPromise(
      t.session.sendTurn({
        turnId: auto.turnId,
        prompt: "Continue",
        attachments: [],
        model: null,
        effort: null,
      })
    );
    const resumed = await t.fake.nextInput(1);
    await Effect.runPromise(
      t.session.sendTurn({
        turnId: auto.turnId,
        prompt: "Also check this",
        attachments: [],
        model: null,
        effort: null,
      })
    );
    const steered = await t.fake.nextInput(2);
    t.fake.emit(result([resumed.uuid!, steered.uuid!]));
    await t.settle();
    expect(t.events.filter(HarnessEvent.$is("TurnEnded"))[2]).toMatchObject({
      turnId: auto.turnId,
      status: "completed",
    });
    expect(
      t.events.find(
        (event) =>
          HarnessEvent.$is("ItemCompleted")(event) && TurnItem.guards.UserMessage(event.item)
      )
    ).toMatchObject({ turnId: auto.turnId, item: { text: "Also check this" } });
  } finally {
    await t.close();
  }
});
