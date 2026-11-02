/**
 * Plan mode against the installed `claude`, driven by a fake Messages API (no sign-in, no
 * model): the scripted model tries to write a file, then asks to leave plan mode.
 * Opt in with `POLARIS_E2E_CLAUDE_PLAN=1 bun test plan.e2e`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ApprovalDecision, SessionId, TurnId, WorkspaceId } from "@polaris/protocol";
import { VisualizeResult } from "@polaris/visualization";
import { Effect, Exit, Schema, Scope, Stream } from "effect";
import { removeTempDir, tempDir } from "../../git/testing.ts";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { fakeAnthropic, type ToolCall } from "./fakeAnthropic.testing.ts";
import { McpBinding } from "../../mcp/binding.ts";
import { constellationTools } from "../../mcp/tools.ts";
import { fakeCommands, leadBinding } from "../../mcp/testing.ts";
import type { ConstellationAttachment } from "../constellation/attachment.ts";

const enabled = process.env.POLARIS_E2E_CLAUDE_PLAN === "1";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Runs `turns` planning Turns of `calls`, answering every approval with `decide`. */
const plan = async (
  calls: (cwd: string) => ReadonlyArray<ToolCall>,
  decide: (event: HarnessEvent) => ApprovalDecision,
  turns = 1,
  constellations: ReadonlyArray<ConstellationAttachment> = []
) => {
  const base = tempDir("polaris-e2e-plan-");
  cleanup.push(() => removeTempDir(base));
  const cwd = join(base, "work");
  const config = join(base, "config");
  mkdirSync(cwd);
  mkdirSync(config);
  const fake = fakeAnthropic(calls(cwd));
  cleanup.push(fake.stop);
  const driver = makeClaudeDriver();
  const scope = Effect.runSync(Scope.make());

  const session = await Effect.runPromise(
    driver
      .open({
        sessionId: SessionId.make("e2e-plan"),
        cwd,
        permissionMode: "plan",
        model: null,
        effort: null,
        resumeCursor: null,
        constellations,
        environment: {
          ANTHROPIC_API_KEY: "sk-ant-fake",
          ANTHROPIC_BASE_URL: fake.url,
          CLAUDE_CONFIG_DIR: config,
        },
      })
      .pipe(Scope.provide(scope))
  );

  const events: Array<HarnessEvent> = [];

  Effect.runFork(
    Stream.runForEach(session.events, (event) =>
      Effect.gen(function* () {
        events.push(event);

        if (HarnessEvent.$is("ApprovalRequested")(event))
          yield* session.respond(event.requestId, decide(event));
      })
    )
  );

  for (let turn = 1; turn <= turns; turn++) {
    const turnId = TurnId.make(`e2e-plan-turn-${turn}`);
    await Effect.runPromise(
      session.sendTurn({
        turnId,
        prompt: "Add a greeting file.",
        attachments: [],
        model: null,
        effort: null,
      })
    );
    const ended = (e: HarnessEvent) => HarnessEvent.$is("TurnEnded")(e) && e.turnId === turnId;

    for (let i = 0; i < 1200 && !events.some(ended); i++) await Bun.sleep(100);
  }

  await Effect.runPromise(Scope.close(scope, Exit.void));

  return { cwd, events, outputs: fake.outputs, bodies: fake.bodies, offered: fake.offered };
};

const write = (cwd: string): ToolCall => ({
  name: "Write",
  input: { file_path: join(cwd, "greeting.txt"), content: "hello\n" },
});

const exitPlan: ToolCall = { name: "ExitPlanMode", input: { plan: "Write greeting.txt." } };

/** What Claude Code tells the model in plan mode, and on leaving it. */
const PLAN_ACTIVE = "Plan mode is active.";

const PLAN_EXITED = "You have exited plan mode.";

const approvals = (events: ReadonlyArray<HarnessEvent>) =>
  events.flatMap((e) => (HarnessEvent.$is("ApprovalRequested")(e) ? [e.kind] : []));

/** Claude Code's record of an MCP result: its content blocks, here one JSON text. */
const decodeOutput = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.Struct({ text: Schema.fromJsonString(VisualizeResult) })])
  )
);

/** A plain session's Polaris tools, in process as Claude gets them. */
const plainTools = (): ConstellationAttachment => {
  const binding = McpBinding.cases.Plain.make({
    sessionId: SessionId.make("e2e-plan"),
    constellationId: leadBinding.constellationId,
    workspaceId: WorkspaceId.make("workspace"),
  });

  return {
    sessionId: binding.sessionId,
    url: "http://127.0.0.1:1/mcp/unused",
    instructions: "",
    tools: constellationTools(binding, fakeCommands().commands),
  };
};

describe.skipIf(!enabled)("plan mode in the real claude", () => {
  test(
    "visualize runs while planning without asking",
    async () => {
      const { events, outputs } = await plan(
        () => [{ name: "mcp__polaris__visualize", input: { title: "Chart", html: "<p>1</p>" } }],
        () => ApprovalDecision.cases.Deny.make({ reason: "Should not ask." }),
        1,
        [plainTools()]
      );

      expect(approvals(events)).toEqual([]);
      const [{ text }] = decodeOutput(outputs[0]);
      expect(text).toMatchObject({ title: "Chart", bytes: 8 });
      expect(text.id).toMatch(/^viz_/);
    },
    { timeout: 180_000 }
  );

  test(
    "an edit while planning asks first and, declined, writes nothing; the plan is put to the user",
    async () => {
      const { cwd, events, outputs, bodies } = await plan(
        (dir) => [write(dir), exitPlan],
        () => ApprovalDecision.cases.Deny.make({ reason: "Still planning." })
      );

      expect(bodies[0]).toContain(PLAN_ACTIVE);
      expect(outputs).toEqual(["Still planning.", "Still planning."]);
      expect(existsSync(join(cwd, "greeting.txt"))).toBe(false);
      expect(approvals(events)).toEqual(["file-change", "tool"]);
      expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({ status: "completed" });
    },
    { timeout: 180_000 }
  );

  test(
    "approving the plan lets Claude out of plan mode; a session still in plan plans again next Turn",
    async () => {
      const { cwd, events, bodies } = await plan(
        (dir) => [exitPlan, write(dir)],
        (e) =>
          HarnessEvent.$is("ApprovalRequested")(e) && e.kind === "tool"
            ? ApprovalDecision.cases.Allow.make({ remember: false })
            : ApprovalDecision.cases.Deny.make({ reason: "Not yet." }),
        2
      );

      // Out of plan mode Claude still asked before the edit: it went back to default, not past it.
      expect(approvals(events)).toEqual(["tool", "file-change"]);
      expect(existsSync(join(cwd, "greeting.txt"))).toBe(false);
      const last = bodies.at(-1)!;
      expect(last.lastIndexOf(PLAN_ACTIVE)).toBeGreaterThan(last.indexOf(PLAN_EXITED));
      expect(last.indexOf(PLAN_EXITED)).toBeGreaterThan(-1);
    },
    { timeout: 180_000 }
  );
});
