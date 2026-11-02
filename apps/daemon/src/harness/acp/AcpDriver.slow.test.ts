import { afterEach, describe, expect, test } from "bun:test";
import {
  ApprovalDecision,
  type PermissionMode,
  SessionId,
  TurnId,
  TurnItem,
} from "@polaris/protocol";
import { Effect, Exit, Scope } from "effect";
import { type HarnessDriver, HarnessEvent, type HarnessSession } from "../HarnessDriver.ts";
import { makeAcpDriver } from "./AcpDriver.ts";
import { COPILOT } from "./harnesses.ts";
import type { Scenario } from "./testing/fakeAgent.ts";
import { type Collected, collect, type FakeBinary, fakeBinary } from "./testing/harness.ts";
import { polarisContextWithoutTools } from "../../constellation/skills/preamble.ts";

interface OpenOptions {
  readonly permissionMode?: PermissionMode;
  readonly resumeCursor?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
}

interface OpenSession extends Collected {
  readonly session: HarnessSession;
  readonly close: () => Promise<void>;
}

interface FakeAgent extends Omit<FakeBinary, "remove"> {
  readonly driver: HarnessDriver;
  readonly open: (options?: OpenOptions) => Promise<OpenSession>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A Copilot driver whose binary is the fake agent; nothing starts until the first `open`. */
const start = async (scenario: Scenario): Promise<FakeAgent> => {
  const fake = fakeBinary(scenario);
  const scope = Effect.runSync(Scope.make());

  const driver = await Effect.runPromise(
    Scope.provide(
      makeAcpDriver({ harness: COPILOT, binaryPath: () => fake.binary, listCwd: fake.dir }),
      scope
    )
  );

  cleanups.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fake.remove();
  });

  const open = async (options: OpenOptions = {}): Promise<OpenSession> => {
    const sessionScope = Effect.runSync(Scope.make());

    const session = await Effect.runPromise(
      Scope.provide(
        driver.open({
          sessionId: SessionId.make("s-1"),
          cwd: fake.dir,
          permissionMode: options.permissionMode ?? "supervised",
          model: options.model ?? null,
          effort: options.effort ?? null,
          resumeCursor: options.resumeCursor ?? null,
        }),
        sessionScope
      )
    );

    return {
      session,
      ...collect(session),
      close: () => Effect.runPromise(Scope.close(sessionScope, Exit.void)),
    };
  };

  return { ...fake, driver, open };
};

/** The error an effect fails with. */
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

const turn = (id: string, prompt = "hi") => ({
  turnId: TurnId.make(id),
  prompt,
  attachments: [],
  model: null,
  effort: null,
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const text = (value: string) => ({ type: "text", text: value });

const shellCall = {
  toolCallId: "call-1",
  title: "Run tests",
  kind: "execute",
  status: "pending",
  rawInput: { command: "bun test" },
};

const options = [
  { optionId: "yes", name: "Allow", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fast",
    options: [
      { value: "fast", name: "Fast", description: "Quick" },
      { value: "smart", name: "Smart" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      {
        group: "levels",
        name: "Levels",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ],
  },
];

describe("ACP driver", () => {
  test("a read-only session (the Reviewer) is refused: the agent's own tools could read anywhere", async () => {
    const agent = await start({ initialize: { protocolVersion: 1, agentCapabilities: {} } });
    const scope = Effect.runSync(Scope.make());

    const error = await failure(
      Scope.provide(
        agent.driver.open({
          sessionId: SessionId.make("s-1"),
          cwd: agent.dir,
          permissionMode: "supervised",
          model: null,
          effort: null,
          resumeCursor: null,
          readOnly: true,
        }),
        scope
      )
    );

    expect(error.message).toBe(
      "GitHub Copilot CLI can't keep the reviewer to its checkout. Choose Claude Code, Codex or OpenCode as the reviewer."
    );
  });

  test("fresh and resumed sessions get hidden first-Turn context; only the user prompt is visible", async () => {
    for (const resumeCursor of [null, "acp-existing"]) {
      const context = polarisContextWithoutTools();

      const agent = await start({
        initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        prompts: [
          { steps: [{ update: { sessionUpdate: "user_message_chunk", content: text(context) } }] },
        ],
      });

      const open = await agent.open({ resumeCursor });

      await run(open.session.sendTurn(turn("context-first", "Please inspect this change")));
      await open.waitFor("TurnEnded");
      await run(open.session.sendTurn(turn("context-second", "Continue")));
      await open.waitFor("TurnEnded", 2);

      const prompts = agent.received().filter((m) => m.method === "session/prompt");
      expect(prompts[0]?.params?.prompt).toEqual([
        text(context),
        text("Please inspect this change"),
      ]);
      expect(prompts[1]?.params?.prompt).toEqual([text("Continue")]);
      expect(
        open.events.flatMap((event) =>
          HarnessEvent.$is("TurnStarted")(event) ? [event.prompt] : []
        )
      ).toEqual(["Please inspect this change", "Continue"]);
      expect(open.events.filter(HarnessEvent.$is("ItemCompleted"))).toEqual([]);
      expect(open.events.filter(HarnessEvent.$is("ItemDelta"))).toEqual([]);
      await open.close();
    }
  });
  test("a Turn: text, thoughts, a tool call and a plan become items; the title is suggested", async () => {
    const agent = await start({
      sessionId: "acp-1",
      prompts: [
        {
          steps: [
            { update: { sessionUpdate: "agent_thought_chunk", content: text("Thinking") } },
            { update: { sessionUpdate: "agent_message_chunk", content: text("Hel") } },
            { update: { sessionUpdate: "agent_message_chunk", content: text("lo") } },
            { update: { sessionUpdate: "tool_call", ...shellCall, status: "in_progress" } },
            {
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "call-1",
                status: "completed",
                content: [{ type: "content", content: text("3 pass") }],
                rawOutput: { exit_code: 0 },
              },
            },
            {
              update: {
                sessionUpdate: "plan",
                entries: [
                  { content: "Test", priority: "high", status: "completed" },
                  { content: "Ship", priority: "low", status: "in_progress" },
                ],
              },
            },
            { update: { sessionUpdate: "usage_update", used: 10, size: 100 } },
            { update: { sessionUpdate: "session_info_update", title: "Testing" } },
            { update: { sessionUpdate: "agent_message_chunk", content: text("Done") } },
          ],
        },
      ],
    });

    const open = await agent.open();
    await run(open.session.sendTurn(turn("t-1", "run the tests")));
    await open.waitFor("TurnEnded");

    const tags = open.events.map((event) => event._tag);
    expect(tags.slice(0, 2)).toEqual(["CursorAssigned", "TurnStarted"]);
    expect(open.events[0]).toMatchObject({ cursor: "acp-1" });
    expect(open.events[1]).toMatchObject({ prompt: "run the tests" });

    const completed = open.events.flatMap((event) =>
      HarnessEvent.$is("ItemCompleted")(event) ? [event.item] : []
    );

    // Thinking is live from its first chunk and completes with the times it streamed.
    const thinking = open.events.find(HarnessEvent.$is("ItemUpdated"));
    expect(thinking?.item).toMatchObject({ text: "", endedAt: null });
    const [reasoning, ...rest] = completed;

    if (reasoning === undefined || !TurnItem.guards.Reasoning(reasoning))
      throw new Error("no reasoning");
    expect(reasoning).toMatchObject({ id: "t-1:reasoning:1", text: "Thinking" });
    expect([reasoning.startedAt, reasoning.endedAt]).not.toContain(null);
    expect(open.events.find(HarnessEvent.$is("ContextUsed"))).toMatchObject({
      usedTokens: 10,
      windowTokens: 100,
    });

    expect(rest).toEqual([
      TurnItem.cases.AssistantMessage.make({ id: "t-1:text:2", text: "Hello" }),
      TurnItem.cases.CommandExecution.make({
        id: "call-1",
        command: "bun test",
        cwd: agent.dir,
        output: "3 pass",
        exitCode: 0,
        status: "completed",
      }),
      TurnItem.cases.AssistantMessage.make({ id: "t-1:text:3", text: "Done" }),
      TurnItem.cases.Plan.make({
        id: "t-1:plan",
        steps: [
          { text: "Test", status: "completed", detail: null },
          { text: "Ship", status: "in-progress", detail: null },
        ],
        explanation: null,
      }),
    ]);
    expect(open.events).toContainEqual(HarnessEvent.TitleSuggested({ title: "Testing" }));
    expect(open.events).toContainEqual(
      HarnessEvent.ItemUpdated({
        turnId: TurnId.make("t-1"),
        item: TurnItem.cases.CommandExecution.make({
          id: "call-1",
          command: "bun test",
          cwd: agent.dir,
          output: "",
          exitCode: null,
          status: "running",
        }),
      })
    );
    expect(open.events.at(-1)).toEqual(
      HarnessEvent.TurnEnded({ turnId: TurnId.make("t-1"), status: "completed", error: null })
    );
    expect(agent.received().find((m) => m.method === "initialize")?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  });

  test("a permission request becomes Needs You; Allow picks the agent's allow option", async () => {
    const agent = await start({
      prompts: [{ steps: [{ permission: { toolCall: shellCall, options } }] }],
    });

    const open = await agent.open({ permissionMode: "auto-edits" });
    await run(open.session.sendTurn(turn("t-1")));
    const asked = await open.waitFor("ApprovalRequested");
    expect(asked).toMatchObject({ kind: "command", title: "Run tests", detail: "bun test" });

    if (!HarnessEvent.$is("ApprovalRequested")(asked)) throw new Error("unreachable");
    await run(
      open.session.respond(asked.requestId, ApprovalDecision.cases.Allow.make({ remember: true }))
    );
    await open.waitFor("TurnEnded");

    expect(agent.received().find((m) => m.id === 1000)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
  });

  test("Deny rejects and marks the tool call declined", async () => {
    const agent = await start({
      prompts: [
        {
          steps: [
            { update: { sessionUpdate: "tool_call", ...shellCall } },
            { permission: { toolCall: { toolCallId: "call-1" }, options } },
          ],
        },
      ],
    });

    const open = await agent.open();
    await run(open.session.sendTurn(turn("t-1")));
    const asked = await open.waitFor("ApprovalRequested");

    if (!HarnessEvent.$is("ApprovalRequested")(asked)) throw new Error("unreachable");
    await run(
      open.session.respond(asked.requestId, ApprovalDecision.cases.Deny.make({ reason: null }))
    );
    await open.waitFor("TurnEnded");

    expect(agent.received().find((m) => m.id === 1000)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "no" },
    });

    const declined = open.events.flatMap((event) =>
      HarnessEvent.$is("ItemCompleted")(event) ? [event.item] : []
    );

    expect(declined.find((item) => item.id === "call-1")).toMatchObject({ status: "declined" });
  });

  test("the permission mode lets reads (supervised) or everything (full access) through", async () => {
    const read = { toolCallId: "r", title: "Read a file", kind: "read" };

    const agent = await start({
      prompts: [
        {
          steps: [
            { permission: { toolCall: read, options } },
            { permission: { toolCall: shellCall, options } },
          ],
        },
      ],
    });

    const open = await agent.open({ permissionMode: "full-access" });
    await run(open.session.sendTurn(turn("t-1")));
    await open.waitFor("TurnEnded");

    expect(open.events.some(HarnessEvent.$is("ApprovalRequested"))).toBe(false);
    expect(
      agent
        .received()
        .filter((m) => m.result !== undefined)
        .map((m) => m.result)
    ).toEqual([
      { outcome: { outcome: "selected", optionId: "yes" } },
      { outcome: { outcome: "selected", optionId: "yes" } },
    ]);
  });

  test("interrupt cancels the Turn and withdraws its open approvals", async () => {
    const agent = await start({
      prompts: [
        {
          steps: [
            { update: { sessionUpdate: "tool_call", ...shellCall } },
            { waitForCancel: true },
          ],
        },
      ],
    });

    const open = await agent.open();
    await run(open.session.sendTurn(turn("t-1")));
    await open.waitFor("ItemUpdated");
    await run(open.session.interrupt);
    await open.waitFor("TurnEnded");

    expect(open.events.at(-1)).toEqual(
      HarnessEvent.TurnEnded({ turnId: TurnId.make("t-1"), status: "interrupted", error: null })
    );
    expect(agent.methods()).toContain("session/cancel");
  });

  test("a second Turn while one runs is refused; steering isn't offered", async () => {
    const agent = await start({ prompts: [{ steps: [{ waitForCancel: true }] }] });
    const open = await agent.open();
    await run(open.session.sendTurn(turn("t-1")));

    expect((await failure(open.session.sendTurn(turn("t-2")))).message).toMatch(
      /already in progress/
    );
    expect((await failure(open.session.steer("faster"))).message).toMatch(/can't take guidance/);
    await run(open.session.interrupt);
    await open.waitFor("TurnEnded");
  });

  test("a Harness that isn't signed in fails to open, pointing at its own sign-in", async () => {
    const agent = await start({
      newSessionError: { code: -32000, message: "Authentication required" },
    });

    const refused = await agent.open().then(
      () => "opened",
      (error: Error) => error.message
    );

    expect(refused).toMatch(
      /GitHub Copilot CLI isn't signed in on this host\. Sign in to GitHub Copilot CLI/
    );
    expect(agent.methods()).not.toContain("authenticate");
  });

  test("resume loads the session and drops its replayed history", async () => {
    const agent = await start({
      initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      replay: [
        { sessionUpdate: "user_message_chunk", content: text("old question") },
        { sessionUpdate: "agent_message_chunk", content: text("old answer") },
      ],
    });

    const open = await agent.open({ resumeCursor: "acp-old" });
    await run(open.session.sendTurn(turn("t-1")));
    await open.waitFor("TurnEnded");

    expect(agent.received().find((m) => m.method === "session/load")?.params).toMatchObject({
      sessionId: "acp-old",
      cwd: agent.dir,
      mcpServers: [],
    });
    expect(open.events[0]).toEqual(HarnessEvent.CursorAssigned({ cursor: "acp-old" }));
    expect(open.events.some(HarnessEvent.$is("ItemDelta"))).toBe(false);
  });

  test("resume prefers session/resume when the Harness declares it", async () => {
    const agent = await start({
      prompts: [
        { steps: [{ update: { sessionUpdate: "agent_message_chunk", content: text("back") } }] },
      ],
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
      },
    });

    const open = await agent.open({ resumeCursor: "acp-old" });
    await run(open.session.sendTurn(turn("t-1")));
    await open.waitFor("TurnEnded");
    await open.close();

    expect(open.events.some(HarnessEvent.$is("ItemCompleted"))).toBe(true);
    expect(agent.methods()).toEqual([
      "initialize",
      "session/resume",
      "session/prompt",
      "session/close",
    ]);
  });

  test("Model and effort go through config options; listModels reads them", async () => {
    const agent = await start({ setup: { configOptions } });

    expect(await run(agent.driver.listModels ?? Effect.die("no listModels"))).toEqual([
      expect.objectContaining({
        id: "fast",
        name: "Fast",
        description: "Quick",
        isDefault: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      }),
      expect.objectContaining({ id: "smart", isDefault: false }),
    ]);

    const open = await agent.open({ model: "smart" });
    await run(open.session.sendTurn({ ...turn("t-1"), model: "smart", effort: "high" }));
    await open.waitFor("TurnEnded");
    await run(open.session.sendTurn({ ...turn("t-2"), model: "unknown-model", effort: null }));
    await open.waitFor("TurnEnded", 2);

    const sets = agent.received().filter((m) => m.method === "session/set_config_option");
    expect(sets.map((m) => [m.params?.configId, m.params?.value])).toEqual([
      ["model", "smart"],
      ["effort", "high"],
    ]);
  });

  test("listCommands returns what a session in that directory last reported", async () => {
    const agent = await start({
      prompts: [
        {
          steps: [
            {
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [
                  { name: "web", description: "Search the web", input: { hint: "<query>" } },
                  { name: "explain", description: "Explain the code" },
                ],
              },
            },
          ],
        },
      ],
    });

    const list = agent.driver.listCommands ?? (() => Effect.die("no listCommands"));
    expect(await run(list(agent.dir))).toEqual([]);

    const open = await agent.open();
    await run(open.session.sendTurn(turn("t-1")));
    await open.waitFor("TurnEnded");

    expect((await run(list(agent.dir))).map((c) => [c.name, c.argumentHint, c.run])).toEqual([
      ["explain", null, "text"],
      ["web", "<query>", "text"],
    ]);
    expect(await run(list("/elsewhere"))).toEqual([]);
  });

  test("the permission mode selects the matching session mode", async () => {
    const agent = await start({
      setup: {
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "yolo", name: "YOLO" },
          ],
        },
      },
    });

    const open = await agent.open({ permissionMode: "full-access" });
    await run(open.session.setPermissionMode("supervised"));
    await run(open.session.setPermissionMode("auto-edits"));

    const modes = agent.received().filter((m) => m.method === "session/set_mode");
    expect(modes.map((m) => m.params?.modeId)).toEqual(["yolo", "default"]);
  });

  test("plan selects the agent's plan mode, or its default mode when it has none", async () => {
    const withPlan = await start({
      setup: {
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
      },
    });

    const planning = await withPlan.open({ permissionMode: "plan" });
    await run(planning.session.setPermissionMode("supervised"));

    const withoutPlan = await start({
      setup: {
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "yolo", name: "YOLO" },
          ],
        },
      },
    });

    const fallback = await withoutPlan.open({ permissionMode: "full-access" });
    await run(fallback.session.setPermissionMode("plan"));

    const modeIds = (agent: typeof withPlan) =>
      agent
        .received()
        .filter((m) => m.method === "session/set_mode")
        .map((m) => m.params?.modeId);

    expect(modeIds(withPlan)).toEqual(["plan", "default"]);
    expect(modeIds(withoutPlan)).toEqual(["yolo", "default"]);
  });

  test("sessions share one agent process; a crash ends them and the next open starts a new one", async () => {
    const agent = await start({ prompts: [{ steps: [{ exit: 3 }] }] });
    const first = await agent.open();
    const second = await agent.open();

    expect(agent.methods().filter((m) => m === "initialize")).toHaveLength(1);
    await run(first.session.sendTurn(turn("t-1")));
    const exited = await second.waitFor("Exited");
    expect(HarnessEvent.$is("Exited")(exited) && exited.error).toMatch(/copilot exited \(3\)/);

    await agent.open();
    expect(agent.methods().filter((m) => m === "initialize")).toHaveLength(2);
  });

  test("terminal handoff reopens the session in the Harness's own TUI", async () => {
    const agent = await start({ sessionId: "acp-9" });
    const open = await agent.open();

    const argv = await run(open.session.terminalCommand);
    expect(argv.slice(1)).toEqual(["--resume=acp-9"]);
  });

  test("closing the last session stops the agent process", async () => {
    const agent = await start({
      initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
    });

    const open = await agent.open();
    await open.close();

    expect(await open.waitFor("Exited")).toEqual(HarnessEvent.Exited({ error: null }));
    expect(agent.methods()).toEqual(["initialize", "session/new", "session/close"]);
  });
});
