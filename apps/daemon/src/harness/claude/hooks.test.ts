import { tempDir } from "../../platform/tempDir.testing.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestId, SessionId, TurnId, TurnItem } from "@polaris/protocol";
import { Effect, Exit, Option, Schema, Scope, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { FakeClaude, init } from "./fakeClaude.ts";
import { ClaudeHookReceiver, FOLLOWED_HOOK_EVENTS, HookTranslator, hookSettings } from "./hooks.ts";
import { decodeHookBody, HookBody } from "./payloads.ts";

const base = { session_id: "cs-1", transcript_path: "/t.jsonl", cwd: "/work/repo" };

const sequence = () => {
  let n = 0;

  return {
    newTurnId: () => TurnId.make(`t${++n}`),
    newRequestId: () => RequestId.make(`r${++n}`),
  };
};

const parseHook = Schema.decodeUnknownSync(HookBody);

const t1 = TurnId.make("t1");

const r2 = RequestId.make("r2");

/** The hook settings file, as far as the tests read it. */
const SettingsFile = Schema.fromJsonString(
  Schema.Struct({
    hooks: Schema.Struct({
      Stop: Schema.NonEmptyArray(
        Schema.Struct({
          hooks: Schema.NonEmptyArray(
            Schema.Struct({
              url: Schema.String,
              headers: Schema.Record(Schema.String, Schema.String),
            })
          ),
        })
      ),
    }),
  })
);

describe("hookSettings", () => {
  test("subscribes every followed event over http with the bearer token and a short timeout", () => {
    const settings = hookSettings({ url: "http://127.0.0.1:9/hooks/s", token: "tok" });
    expect(Object.keys(settings.hooks)).toEqual([...FOLLOWED_HOOK_EVENTS]);
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "http",
            url: "http://127.0.0.1:9/hooks/s",
            headers: { Authorization: "Bearer tok" },
            timeout: 5,
          },
        ],
      },
    ]);
    expect(settings.hooks.Stop?.[0]).not.toHaveProperty("matcher");
  });
});

describe("HookTranslator", () => {
  test("a Turn typed in the TUI, with a tool, a permission prompt, and a stop", () => {
    const h = new HookTranslator({ cursor: "cs-1", ...sequence() });

    const events: unknown[] = [
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "run tests" },
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tu1",
        tool_input: { command: "bun test" },
      },
      {
        ...base,
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use Bash",
      },
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "tu1",
        tool_input: { command: "bun test" },
        tool_response: { stdout: "17 pass", stderr: "", interrupted: false },
      },
      {
        ...base,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "Green.",
      },
    ].flatMap((b) => h.onHook(parseHook(b)));

    expect(events).toEqual([
      // The Turn carries what the user typed in the TUI.
      HarnessEvent.TurnStarted({ turnId: t1, prompt: "run tests" }),
      HarnessEvent.ItemUpdated({
        turnId: t1,
        item: TurnItem.cases.CommandExecution.make({
          id: "tu1",
          command: "bun test",
          cwd: "/work/repo",
          output: "",
          exitCode: null,
          status: "running",
        }),
      }),
      HarnessEvent.ApprovalRequested({
        turnId: t1,
        requestId: r2,
        kind: "command",
        title: "Claude needs your permission to use Bash",
        detail: "bun test",
        options: [],
      }),
      HarnessEvent.ApprovalWithdrawn({ requestId: r2 }),
      HarnessEvent.ItemCompleted({
        turnId: t1,
        item: TurnItem.cases.CommandExecution.make({
          id: "tu1",
          command: "bun test",
          cwd: "/work/repo",
          output: "17 pass",
          exitCode: null,
          status: "completed",
        }),
      }),
      HarnessEvent.ItemCompleted({
        turnId: t1,
        item: TurnItem.cases.AssistantMessage.make({ id: "stop:t1", text: "Green." }),
      }),
      HarnessEvent.TurnEnded({ turnId: t1, status: "completed", error: null }),
    ]);
  });

  test("a new cursor, failures, plans, subagents and session end", () => {
    const h = new HookTranslator({ cursor: null, ...sequence() });

    const events: unknown[] = [
      {
        ...base,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Edit",
        tool_use_id: "tu1",
        tool_input: { file_path: "/work/repo/a.ts" },
        error: "no match",
      },
      {
        ...base,
        agent_id: "sub-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tu2",
        tool_input: {},
      },
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "TodoWrite",
        tool_use_id: "tu3",
        tool_input: { todos: [{ content: "a", status: "in_progress", activeForm: "a" }] },
        tool_response: {},
      },
      { ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" },
      { ...base, hook_event_name: "Stop" },
    ].flatMap((b) => h.onHook(parseHook(b)));

    expect(events).toEqual([
      HarnessEvent.CursorAssigned({ cursor: "cs-1" }),
      HarnessEvent.TurnStarted({ turnId: t1, prompt: null }),
      HarnessEvent.ItemCompleted({
        turnId: t1,
        item: TurnItem.cases.FileChange.make({
          id: "tu1",
          changes: [{ path: "/work/repo/a.ts", kind: "modify" }],
          status: "failed",
        }),
      }),
      // Live while the Turn runs, persisted once when it ends.
      HarnessEvent.ItemUpdated({
        turnId: t1,
        item: TurnItem.cases.Plan.make({
          id: "plan:t1",
          steps: [{ text: "a", status: "in-progress", detail: null }],
          explanation: null,
        }),
      }),
      HarnessEvent.ItemCompleted({
        turnId: t1,
        item: TurnItem.cases.Plan.make({
          id: "plan:t1",
          steps: [{ text: "a", status: "in-progress", detail: null }],
          explanation: null,
        }),
      }),
      HarnessEvent.TurnEnded({ turnId: t1, status: "interrupted", error: null }),
      HarnessEvent.Exited({ error: null }),
    ]);
    expect(h.isEnded).toBe(true);
  });

  test("follows the TUI to a new session id (resume picked another, or /clear)", () => {
    const h = new HookTranslator({ cursor: "cs-1", ...sequence() });

    const events: unknown[] = [
      { ...base, hook_event_name: "SessionStart", source: "resume" },
      { ...base, session_id: "cs-2", hook_event_name: "SessionStart", source: "clear" },
      { ...base, session_id: "cs-2", hook_event_name: "UserPromptSubmit", prompt: "again" },
    ].flatMap((b) => h.onHook(parseHook(b)));

    expect(events).toEqual([
      HarnessEvent.CursorAssigned({ cursor: "cs-2" }),
      HarnessEvent.TurnStarted({ turnId: t1, prompt: "again" }),
    ]);
  });

  test("ignores malformed bodies and notifications that aren't permission prompts", () => {
    const h = new HookTranslator({ cursor: "cs-1" });
    expect(Option.isNone(decodeHookBody("nope"))).toBe(true);
    expect(
      h.onHook(
        parseHook({ ...base, hook_event_name: "Notification", notification_type: "idle_prompt" })
      )
    ).toEqual([]);
  });
});

describe("ClaudeHookReceiver", () => {
  const withReceiver = async (
    body: (receiver: ClaudeHookReceiver["Service"], settingsDir: string) => Promise<void>
  ) => {
    const settingsDir = join(tempDir("polaris-hooks-"), "hooks");
    const scope = Effect.runSync(Scope.make());

    const receiver = await Effect.runPromise(
      ClaudeHookReceiver.make({ settingsDir }).pipe(Scope.provide(scope))
    );

    try {
      await body(receiver, settingsDir);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  };

  test("writes a private settings file and follows a session over loopback", async () => {
    await withReceiver(async (receiver, settingsDir) => {
      const sessionId = SessionId.make("session-1");

      const { settingsPath } = await Effect.runPromise(
        receiver.prepare({ sessionId, cursor: "cs-1" })
      );

      // Windows has no mode bits; the file's ACL is ENG-314's.
      if (process.platform !== "win32") expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
      const settings = Schema.decodeUnknownSync(SettingsFile)(await readFile(settingsPath, "utf8"));
      const hook = settings.hooks.Stop[0].hooks[0];
      expect(hook.url).toBe(`http://127.0.0.1:${receiver.port}/hooks/session-1`);

      const post = (
        headers: Readonly<Record<string, string>>,
        body: Readonly<Record<string, string>>
      ) =>
        fetch(hook.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });

      expect((await post({}, { ...base, hook_event_name: "Stop" })).status).toBe(401);
      expect(
        (await post({ Authorization: "Bearer wrong" }, { ...base, hook_event_name: "Stop" })).status
      ).toBe(401);

      const auth = hook.headers;
      const ok = await post(auth, { ...base, hook_event_name: "UserPromptSubmit", prompt: "hi" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({});
      // Claude Code 2.1.310 names the session in its transcript, never in a hook's body.
      const transcript = join(settingsDir, "..", "cs-1.jsonl");
      await writeFile(transcript, `${JSON.stringify({ type: "ai-title", aiTitle: "Say hi" })}\n`);
      await post(auth, {
        ...base,
        transcript_path: transcript,
        hook_event_name: "Stop",
        last_assistant_message: "hello",
      });
      await post(auth, { ...base, hook_event_name: "SessionEnd", reason: "other" });

      const events: HarnessEvent[] = await Effect.runPromise(
        Stream.runCollect(receiver.events(sessionId))
      );

      expect(events.map((e) => e._tag)).toEqual([
        "TurnStarted",
        "ItemCompleted",
        "TurnEnded",
        "TitleSuggested",
        "Exited",
      ]);
      expect(events.find(HarnessEvent.$is("TitleSuggested"))?.title).toBe("Say hi");

      await Effect.runPromise(receiver.release(sessionId));
      expect(existsSync(settingsPath)).toBe(false);
    });
  });

  test("the driver's terminal command carries the settings file", async () => {
    await withReceiver(async (receiver) => {
      const fake = new FakeClaude();

      const driver = makeClaudeDriver({
        query: fake.query,
        claudePath: () => "/opt/bin/claude",
        hookReceiver: receiver,
      });

      const scope = Effect.runSync(Scope.make());

      const session = await Effect.runPromise(
        driver
          .open({
            sessionId: SessionId.make("session-2"),
            cwd: "/work/repo",
            permissionMode: "supervised",
            model: null,
            effort: null,
            resumeCursor: null,
          })
          .pipe(Scope.provide(scope))
      );

      fake.emit(init("cs-2"));
      let argv: ReadonlyArray<string> = [];

      for (let i = 0; i < 100 && argv.length === 0; i++) {
        await Bun.sleep(2);
        const exit = await Effect.runPromiseExit(session.terminalCommand);

        if (Exit.isSuccess(exit)) argv = exit.value;
      }

      expect(argv.slice(0, 4)).toEqual(["claude", "--resume", "cs-2", "--settings"]);
      expect(argv[4]).toEndWith(join("hooks", "session-2.json"));
      await Effect.runPromise(Scope.close(scope, Exit.void));
    });
  });
});
