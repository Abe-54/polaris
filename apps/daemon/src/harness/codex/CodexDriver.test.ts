import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ApprovalDecision, RequestId, TurnId, TurnItem } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeCodexDriver, probeCodex } from "./CodexDriver.ts";
import { type ClientAnswer, type Handler, readFixture, replay } from "./testing/FakeAppServer.ts";
import { cleanup, ofTag, scripted, sessionWith, THREAD, turn } from "./testing/session.ts";
import { shellFake, shPath } from "../testing/shellFake.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const decodeTurnInput = Schema.decodeUnknownSync(
  Schema.Struct({ input: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })) })
);

const withSession = sessionWith(makeCodexDriver);

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe("Codex driver against a fake app-server", () => {
  test("replays a recorded full Turn", async () => {
    const frames = await readFixture(join(import.meta.dir, "fixtures/full-turn.jsonl"));

    const { events, server } = await withSession(replay(frames), ({ session, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn({
          turnId: TurnId.make("turn-1"),
          prompt: "say ok",
          attachments: [],
          model: null,
          effort: null,
        });
        yield* waitFor("TurnEnded");
      })
    );

    const threadId = "01a0e68a-7f27-7583-8ddc-d1194aeb14f4";
    const messageId = "msg_0829498457dd13ad016ab9fe9bc67087d1a552d9ba43c74252";
    const turnId = TurnId.make("turn-1");
    expect(events).toEqual([
      HarnessEvent.CursorAssigned({ cursor: threadId }),
      HarnessEvent.TurnStarted({ turnId, prompt: "say ok" }),
      HarnessEvent.ItemDelta({ turnId, itemId: messageId, field: "text", text: "ok" }),
      HarnessEvent.ItemCompleted({
        turnId,
        item: TurnItem.cases.AssistantMessage.make({ id: messageId, text: "ok" }),
      }),
      HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }),
      HarnessEvent.Exited({ error: null }),
    ]);
    expect(server.received.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect(server.requests("thread/start")[0]?.params).toMatchObject({
      cwd: "/repo",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
  });

  test("a Turn the API rejects reads as its message, not the raw JSON body", async () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        message: "model 'gpt-6-luna' is not supported for this account",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });

    const error = { message: body, codexErrorInfo: "badRequest", additionalDetails: null };

    const handler = scripted((request, conn) => {
      if (request.method !== "turn/start") return;
      conn.reply({ turn: turn("t1") });
      conn.notify("turn/started", { threadId: THREAD, turn: turn("t1") });
      conn.notify("error", { threadId: THREAD, turnId: "t1", willRetry: false, error });
      conn.notify("turn/completed", { threadId: THREAD, turn: turn("t1", "failed", error) });
    });

    const { events } = await withSession(handler, ({ session, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn({
          turnId: TurnId.make("turn-1"),
          prompt: "hi",
          attachments: [],
          model: "gpt-6-luna",
          effort: "low",
        });
        yield* waitFor("TurnEnded");
      })
    );

    const readable =
      "gpt-6-luna isn't available on this Codex account or plan. Choose another Model. " +
      "Codex said: model 'gpt-6-luna' is not supported for this account";

    expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({
      status: "failed",
      error: readable,
    });
    expect(
      events.flatMap((e) => (HarnessEvent.$is("ItemCompleted")(e) ? [e.item] : []))
    ).toContainEqual(TurnItem.cases.Error.make({ id: "t1:error:1", message: readable }));
    expect(events.find(HarnessEvent.$is("TurnEnded"))?.limit).toBeUndefined();
  });

  test("a Turn Codex ends at the usage limit says so; its reset comes from Plan Limits", async () => {
    const error = {
      message: "You've hit your usage limit. Try again at 2:00 PM.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
    };

    const handler = scripted((request, conn) => {
      if (request.method !== "turn/start") return;
      conn.reply({ turn: turn("t1") });
      conn.notify("turn/started", { threadId: THREAD, turn: turn("t1") });
      conn.notify("turn/completed", { threadId: THREAD, turn: turn("t1", "failed", error) });
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

    expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({
      status: "failed",
      limit: { resetsAt: null },
    });
  });

  test("reasoning is live and timed by Codex's stamps; token usage reports the context", async () => {
    const reasoning = (summary: string[]) => ({
      type: "reasoning",
      id: "r1",
      summary,
      content: [],
    });

    const breakdown = (totalTokens: number) => ({
      totalTokens,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    });

    const handler = scripted((request, conn) => {
      if (request.method !== "turn/start") return;
      conn.reply({ turn: turn("t1") });
      conn.notify("turn/started", { threadId: THREAD, turn: turn("t1") });
      const at = Date.parse("2026-09-30T10:00:00Z");
      const item = { threadId: THREAD, turnId: "t1" };
      conn.notify("item/started", { ...item, startedAtMs: at, item: reasoning([]) });
      conn.notify("item/completed", {
        ...item,
        completedAtMs: at + 12_000,
        item: reasoning(["Planning."]),
      });
      conn.notify("thread/tokenUsage/updated", {
        ...item,
        tokenUsage: {
          total: breakdown(90_000),
          last: breakdown(64_000),
          modelContextWindow: 258_000,
        },
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

    expect(events.find(HarnessEvent.$is("ItemUpdated"))?.item).toMatchObject({
      text: "",
      startedAt: "2026-09-30T10:00:00.000Z",
    });
    expect(events.find(HarnessEvent.$is("ItemCompleted"))?.item).toEqual(
      TurnItem.cases.Reasoning.make({
        id: "r1",
        text: "Planning.",
        startedAt: "2026-09-30T10:00:00.000Z",
        endedAt: "2026-09-30T10:00:12.000Z",
      })
    );
    expect(events.find(HarnessEvent.$is("ContextUsed"))).toEqual(
      HarnessEvent.ContextUsed({ usedTokens: 64_000, windowTokens: 258_000 })
    );
  });

  test("an approval round-trip answers the server request", async () => {
    let approval: Promise<ClientAnswer> = Promise.resolve(null);

    const handler = scripted((request, conn) => {
      if (request.method !== "turn/start") return;
      conn.reply({ turn: turn("t1") });
      conn.notify("turn/started", { threadId: THREAD, turn: turn("t1") });
      approval = conn
        .request("item/commandExecution/requestApproval", {
          threadId: THREAD,
          turnId: "t1",
          itemId: "cmd1",
          startedAtMs: 0,
          kind: "command",
          environmentId: null,
          command: "bun test",
          cwd: "/repo",
          reason: "run the tests",
        })
        .then((answer) => {
          conn.notify("serverRequest/resolved", { threadId: THREAD, requestId: 1000 });
          conn.notify("item/completed", {
            threadId: THREAD,
            turnId: "t1",
            completedAtMs: 0,
            item: {
              type: "commandExecution",
              id: "cmd1",
              command: "bun test",
              cwd: "/repo",
              status: "completed",
              aggregatedOutput: "1 pass",
              exitCode: 0,
              commandActions: [],
              durationMs: 5,
            },
          });
          conn.notify("turn/completed", { threadId: THREAD, turn: turn("t1", "completed") });

          return answer;
        });
    });

    const { events } = await withSession(handler, ({ session, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn({
          turnId: TurnId.make("turn-1"),
          prompt: "test",
          attachments: [],
          model: null,
          effort: null,
        });
        const asked = yield* waitFor("ApprovalRequested");
        expect(asked).toMatchObject({
          turnId: "turn-1",
          kind: "command",
          title: "bun test",
          detail: "run the tests",
        });
        yield* session.respond(
          asked.requestId,
          ApprovalDecision.cases.Allow.make({ remember: true })
        );
        yield* waitFor("TurnEnded");
        expect(yield* Effect.promise(() => approval)).toEqual({ decision: "acceptForSession" });

        // A second answer to the same request is rejected rather than sent twice.
        const again = yield* Effect.flip(
          session.respond(asked.requestId, ApprovalDecision.cases.Allow.make({ remember: false }))
        );

        expect(again.message).toContain("No open Codex request");
      })
    );

    // Our own answer's `serverRequest/resolved` is not reported as a withdrawal.
    expect(ofTag(events, "ApprovalWithdrawn")).toEqual([]);
    expect(ofTag(events, "ItemCompleted")[0]?.item).toEqual(
      TurnItem.cases.CommandExecution.make({
        id: "cmd1",
        command: "bun test",
        cwd: "/repo",
        output: "1 pass",
        exitCode: 0,
        status: "completed",
      })
    );
  });

  test("interrupt stops the Turn and withdraws its open approval", async () => {
    const handler = scripted((request, conn) => {
      switch (request.method) {
        case "turn/start":
          conn.reply({ turn: turn("t1") });
          conn.notify("turn/started", { threadId: THREAD, turn: turn("t1") });
          void conn.request("item/fileChange/requestApproval", {
            threadId: THREAD,
            turnId: "t1",
            itemId: "fc1",
            startedAtMs: 0,
            reason: null,
          });

          return;
        case "turn/interrupt":
          conn.reply({});
          conn.notify("serverRequest/resolved", { threadId: THREAD, requestId: 1000 });
          conn.notify("turn/completed", { threadId: THREAD, turn: turn("t1", "interrupted") });

          return;
      }
    });

    const { events, server } = await withSession(handler, ({ session, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn({
          turnId: TurnId.make("turn-1"),
          prompt: "edit",
          attachments: [],
          model: null,
          effort: null,
        });
        const asked = yield* waitFor("ApprovalRequested");
        expect(asked).toMatchObject({ kind: "file-change", title: "Apply file changes" });
        yield* session.interrupt;
        yield* waitFor("TurnEnded");

        return asked.requestId;
      })
    );

    expect(server.requests("turn/interrupt")[0]?.params).toEqual({
      threadId: THREAD,
      turnId: "t1",
    });
    const tags = events.map((e) => e._tag);
    expect(tags.indexOf("ApprovalWithdrawn")).toBeLessThan(tags.indexOf("TurnEnded"));
    expect(ofTag(events, "TurnEnded")[0]).toMatchObject({ status: "interrupted" });
  });

  test("resume rejoins the thread and follows a Turn started elsewhere", async () => {
    const handler = scripted((request, conn) => {
      if (request.method === "turn/steer") {
        conn.reply({ turnId: "t_tui" });

        // Codex also reports the steer as a user message of the Turn: recorded once.
        for (const method of ["item/started", "item/completed"])
          conn.notify(method, {
            threadId: THREAD,
            turnId: "t_tui",
            item: {
              type: "userMessage",
              id: "u2",
              content: [{ type: "text", text: "also run lint", text_elements: [] }],
            },
          });
        conn.notify("turn/completed", { threadId: THREAD, turn: turn("t_tui", "completed") });
      }
    });

    let sendThreadNotifications: (() => void) | null = null;

    const wrapped: Handler = (request, conn) => {
      if (request.method === "thread/resume")
        sendThreadNotifications = () => {
          // A Turn the co-attached TUI started: no turn/start from Polaris, and we rejoin mid-way.
          conn.notify("item/agentMessage/delta", {
            threadId: THREAD,
            turnId: "t_tui",
            itemId: "m1",
            delta: "Working",
          });
          conn.notify("thread/name/updated", { threadId: THREAD, threadName: "Fix the tests" });
          // Another thread on the shared server is ignored.
          conn.notify("turn/started", { threadId: "thr_other", turn: turn("t_other") });
        };

      return handler(request, conn);
    };

    const { events, server } = await withSession(
      wrapped,
      ({ session, waitFor }) =>
        Effect.gen(function* () {
          sendThreadNotifications?.();
          const delta = yield* waitFor("ItemDelta");
          const started = yield* waitFor("TurnStarted");
          expect(delta).toMatchObject({ itemId: "m1", text: "Working" });
          expect(delta.turnId).toBe(started.turnId);
          yield* waitFor("TitleSuggested");

          // Sending a Turn while one is in flight is refused; steering is the way in.
          const busy = yield* Effect.flip(
            session.sendTurn({
              turnId: TurnId.make("x"),
              prompt: "no",
              attachments: [],
              model: null,
              effort: null,
            })
          );

          expect(busy.message).toContain("already in progress");
          yield* session.steer("also run lint");
          yield* waitFor("TurnEnded");
          // On Windows the TUI reads the server's token in PowerShell (AppServer.slow.test.ts).
          expect(yield* session.terminalCommand).toEqual(
            process.platform === "win32"
              ? ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", expect.any(String)]
              : [
                  "/opt/codex/bin/codex",
                  "resume",
                  THREAD,
                  "--remote",
                  expect.stringMatching(/^unix:\/\/.*\/pcx-[^/]+\/s\.sock$/),
                ]
          );
        }),
      { resumeCursor: THREAD, permissionMode: "auto", serviceTier: "priority" }
    );

    expect(server.requests("thread/resume")[0]?.params).toMatchObject({
      threadId: THREAD,
      excludeTurns: true,
      serviceTier: "priority",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    });
    expect(server.requests("thread/start")).toEqual([]);
    expect(server.requests("turn/steer")[0]?.params).toMatchObject({
      threadId: THREAD,
      expectedTurnId: "t_tui",
      input: [{ type: "text", text: "also run lint" }],
    });
    expect(events[0]).toEqual(HarnessEvent.CursorAssigned({ cursor: THREAD }));
    expect(ofTag(events, "TurnStarted")).toHaveLength(1);
    expect(
      ofTag(events, "ItemCompleted").filter((e) => TurnItem.guards.UserMessage(e.item))
    ).toEqual([
      HarnessEvent.ItemCompleted({
        turnId: ofTag(events, "TurnStarted")[0]?.turnId ?? TurnId.make("missing"),
        item: TurnItem.cases.UserMessage.make({ id: "steer:t_tui:1", text: "also run lint" }),
      }),
    ]);
    expect(ofTag(events, "TitleSuggested")).toEqual([
      HarnessEvent.TitleSuggested({ title: "Fix the tests" }),
    ]);
  });

  test("a Turn typed in the TUI carries its prompt; commands and the plan show live", async () => {
    const command = (status: string, output: string | null) => ({
      type: "commandExecution",
      id: "c1",
      command: "bun test",
      cwd: "/repo",
      status,
      aggregatedOutput: output,
      exitCode: status === "completed" ? 0 : null,
    });

    let tui: (() => void) | null = null;

    const handler: Handler = (request, conn) => {
      if (request.method === "thread/resume")
        tui = () => {
          conn.notify("turn/started", { threadId: THREAD, turn: turn("t_tui") });
          conn.notify("item/started", {
            threadId: THREAD,
            turnId: "t_tui",
            startedAtMs: 0,
            item: {
              type: "userMessage",
              id: "u1",
              clientId: null,
              content: [{ type: "text", text: "fix the tests", text_elements: [] }],
            },
          });
          conn.notify("item/started", {
            threadId: THREAD,
            turnId: "t_tui",
            startedAtMs: 0,
            item: command("inProgress", null),
          });
          conn.notify("turn/plan/updated", {
            threadId: THREAD,
            turnId: "t_tui",
            explanation: null,
            plan: [{ step: "run tests", status: "inProgress" }],
          });
          conn.notify("item/completed", {
            threadId: THREAD,
            turnId: "t_tui",
            completedAtMs: 0,
            item: command("completed", "17 pass"),
          });
          conn.notify("turn/completed", { threadId: THREAD, turn: turn("t_tui", "completed") });
        };

      return scripted(() => {})(request, conn);
    };

    const { events } = await withSession(
      handler,
      ({ waitFor }) =>
        Effect.gen(function* () {
          tui?.();
          yield* waitFor("TurnEnded");
        }),
      { resumeCursor: THREAD }
    );

    const started = ofTag(events, "TurnStarted")[0];
    expect(started).toMatchObject({ prompt: "fix the tests" });
    const turnId = started?.turnId ?? TurnId.make("missing");

    const plan = TurnItem.cases.Plan.make({
      id: "t_tui:plan",
      steps: [{ text: "run tests", status: "in-progress", detail: null }],
      explanation: null,
    });

    const commandItem = (
      output: string,
      exitCode: number | null,
      status: "running" | "completed"
    ) =>
      TurnItem.cases.CommandExecution.make({
        id: "c1",
        command: "bun test",
        cwd: "/repo",
        output,
        exitCode,
        status,
      });

    expect(
      events.filter((e) => !HarnessEvent.$is("CursorAssigned")(e) && !HarnessEvent.$is("Exited")(e))
    ).toEqual([
      HarnessEvent.TurnStarted({ turnId, prompt: "fix the tests" }),
      HarnessEvent.ItemUpdated({ turnId, item: commandItem("", null, "running") }),
      HarnessEvent.ItemUpdated({ turnId, item: plan }),
      HarnessEvent.ItemCompleted({ turnId, item: commandItem("17 pass", 0, "completed") }),
      HarnessEvent.ItemCompleted({ turnId, item: plan }),
      HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }),
    ]);
  });

  test("an async question is answered with a new user message", async () => {
    const handler = scripted((request, conn) => {
      if (request.method !== "turn/start") return;
      const text = decodeTurnInput(request.params).input[0]?.text;
      const id = text === "say hi" ? "t1" : "t2";
      conn.reply({ turn: turn(id) });
      conn.notify("turn/started", { threadId: THREAD, turn: turn(id) });

      if (id === "t1")
        conn.notify("item/completed", {
          threadId: THREAD,
          turnId: "t1",
          completedAtMs: 0,
          item: {
            type: "agentMessage",
            id: "m1",
            text: "Which database?",
            phase: null,
            memoryCitation: null,
            delivery: "async",
            questions: [{ title: "Which database?", options: ["Postgres", "SQLite"] }],
          },
        });
      conn.notify("turn/completed", { threadId: THREAD, turn: turn(id, "completed") });
    });

    const { events, server } = await withSession(handler, ({ session, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn({
          turnId: TurnId.make("turn-1"),
          prompt: "say hi",
          attachments: [],
          model: null,
          effort: null,
        });
        const asked = yield* waitFor("ApprovalRequested");
        expect(asked).toMatchObject({
          kind: "question",
          title: "Which database?",
          options: ["Postgres", "SQLite"],
        });
        yield* waitFor("TurnEnded");
        yield* session.respond(
          asked.requestId,
          ApprovalDecision.cases.Answer.make({ text: "SQLite" })
        );
        yield* waitFor("TurnEnded", (e) => e.turnId !== TurnId.make("turn-1"));
      })
    );

    expect(server.requests("turn/start")[1]?.params).toMatchObject({
      threadId: THREAD,
      input: [{ type: "text", text: "SQLite" }],
    });
    expect(ofTag(events, "TurnStarted")).toMatchObject([
      { prompt: "say hi" },
      { prompt: "SQLite" },
    ]);
  });

  test("refuses credential and unsupported server requests, and reports a dropped server", async () => {
    let refusal: Promise<ClientAnswer> = Promise.resolve(null);
    let drop = () => {};

    const handler = scripted((request, conn) => {
      if (request.method !== "turn/start") return;
      conn.reply({ turn: turn("t1") });
      refusal = conn.request("account/chatgptAuthTokens/refresh", { reason: "unauthorized" });
      drop = conn.drop;
    });

    const { events } = await withSession(handler, ({ session, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn({
          turnId: TurnId.make("turn-1"),
          prompt: "go",
          attachments: [],
          model: null,
          effort: null,
        });
        expect(yield* Effect.promise(() => refusal)).toMatchObject({ error: { code: -32601 } });
        drop();
        yield* waitFor("Exited");
        const failed = yield* Effect.flip(session.steer("anything"));
        expect(failed.message).toBe("turn/steer: Codex app-server connection is closed");
      })
    );

    const exited = ofTag(events, "Exited");
    expect(exited).toHaveLength(1);
    expect(exited[0]?.error).toContain("closed the connection");
  });

  test("responding to an unknown request fails", async () => {
    await withSession(
      scripted(() => {}),
      ({ session }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            session.respond(
              RequestId.make("nope"),
              ApprovalDecision.cases.Deny.make({ reason: null })
            )
          );

          expect(error).toMatchObject({
            harness: "codex",
            message: "No open Codex request nope; it may have been resolved",
          });
        })
    );
  });
});

describe("probe", () => {
  test("only runs `codex --version`", async () => {
    const dir = newTempDir("pcx-", { short: true });
    cleanup.push(() => removeTempDir(dir));
    const log = join(dir, "argv");
    const fake = shellFake(dir, "codex", `echo "$@" >> "${shPath(log)}"\necho "codex-cli 9.8.7"`);
    const probe = await Effect.runPromise(probeCodex(fake));
    expect(probe).toEqual({ available: true, version: "9.8.7", detail: fake });
    expect((await Bun.file(log).text()).trim()).toBe("--version");
  });

  test("reports a missing codex", async () => {
    expect(await Effect.runPromise(probeCodex(null))).toMatchObject({ available: false });
    expect(await Effect.runPromise(probeCodex("/nonexistent/codex"))).toMatchObject({
      available: false,
    });
  });
});
