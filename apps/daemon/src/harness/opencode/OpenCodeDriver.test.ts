import { polarisContextWithoutTools } from "../../constellation/skills/preamble.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalDecision,
  Attachment,
  AttachmentId,
  type PermissionMode,
  RequestId,
  SessionId,
  TurnId,
  TurnItem,
} from "@polaris/protocol";
import { Effect, Schema, Stream } from "effect";
import { HarnessEvent, type HarnessSession } from "../HarnessDriver.ts";
import { rulesetFor } from "./mapping.ts";
import { makeOpenCodeDriver, probeOpenCode } from "./OpenCodeDriver.ts";
import { openSession } from "./OpenCodeSession.ts";
import { events as eventsFor, readFixture } from "./testing/events.ts";
import { FAKE_SESSION_ID, type FakeServer, makeFakeServer } from "./testing/FakeServer.ts";
import { shellFake, shPath } from "../testing/shellFake.ts";

type EventOf<T extends HarnessEvent["_tag"]> = Extract<HarnessEvent, { readonly _tag: T }>;

const ofTag = <T extends HarnessEvent["_tag"]>(events: ReadonlyArray<HarnessEvent>, tag: T) =>
  events.filter(HarnessEvent.$is(tag));

const CWD = "/repo";

const ev = eventsFor(FAKE_SESSION_ID);

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

interface Harness {
  readonly session: HarnessSession;
  readonly fake: FakeServer;
  readonly events: Array<HarnessEvent>;
  readonly emit: (...payloads: ReadonlyArray<unknown>) => void;
  /** The first event with `tag` (and matching `where`), waiting up to two seconds. */
  readonly waitFor: <T extends HarnessEvent["_tag"]>(
    tag: T,
    where?: (e: EventOf<T>) => boolean
  ) => Effect.Effect<EventOf<T>>;
}

interface Options {
  readonly resumeCursor?: string;
  readonly permissionMode?: PermissionMode;
  readonly model?: string | null;
  readonly sessionId?: string;
  readonly setup?: (fake: FakeServer) => void;
}

/** Opens a session against a fake server and runs `body`; the scope closes afterwards. */
const withSession = async <A>(
  body: (h: Harness) => Effect.Effect<A, unknown>,
  options: Options = {}
) => {
  const fake = makeFakeServer({ sessionId: options.sessionId ?? FAKE_SESSION_ID });
  cleanup.push(fake.stop);
  options.setup?.(fake);
  const events: Array<HarnessEvent> = [];

  const program = Effect.gen(function* () {
    const session = yield* openSession(
      fake.asServer("/home/user/.polaris/opencode-server.password"),
      {
        sessionId: SessionId.make("s1"),
        cwd: CWD,
        permissionMode: options.permissionMode ?? "supervised",
        model: options.model ?? null,
        effort: null,
        resumeCursor: options.resumeCursor ?? null,
      }
    );

    yield* session.events.pipe(
      Stream.runForEach((e) => Effect.sync(() => events.push(e))),
      Effect.forkDetach
    );

    const waitFor = <T extends HarnessEvent["_tag"]>(
      tag: T,
      where: (e: EventOf<T>) => boolean = () => true
    ) =>
      Effect.promise(async () => {
        for (let i = 0; i < 200; i++) {
          const found = ofTag(events, tag).find(where);

          if (found) return found;
          await Bun.sleep(10);
        }

        throw new Error(`timed out waiting for ${tag}; saw ${events.map((e) => e._tag).join(",")}`);
      });

    const emit = (...payloads: ReadonlyArray<unknown>) => {
      for (const payload of payloads) fake.emit(CWD, payload);
    };

    return yield* body({ session, fake, events, emit, waitFor });
  });

  const result = await Effect.runPromise(Effect.scoped(program));
  await Bun.sleep(20);

  return { result, events, fake };
};

const turnInput = (
  turnId: string,
  prompt: string,
  model: string | null = null,
  effort: string | null = null
) => ({
  turnId: TurnId.make(turnId),
  prompt,
  attachments: [],
  model,
  effort,
});

const allow = ApprovalDecision.cases.Allow.make({ remember: false });

describe("OpenCode driver", () => {
  test("a full Turn replayed from a real OpenCode 1.18.33 trace, with a command approval", async () => {
    const fixture = readFixture("approval-turn.jsonl");
    const sessionId = "ses_f147115adffe7KqfKB0hSfNOwb";
    const asked = fixture.findIndex((e) => JSON.stringify(e).includes('"permission.asked"'));

    const { events, fake } = await withSession(
      ({ session, emit, waitFor }) =>
        Effect.gen(function* () {
          yield* session.sendTurn(
            turnInput(
              "turn-1",
              "Run the shell command `cat a.txt` and tell me its output in one word.",
              "opencode/big-pickle",
              "high"
            )
          );
          emit(...fixture.slice(0, asked + 1));
          const approval = yield* waitFor("ApprovalRequested");
          yield* session.respond(approval.requestId, allow);
          emit(...fixture.slice(asked + 1));
          yield* waitFor("TurnEnded");
        }),
      { sessionId }
    );

    const [prompt] = fake.sent(`POST /session/${sessionId}/prompt_async`);
    expect(prompt?.directory).toBe(CWD);
    expect(prompt?.body).toEqual({
      system: polarisContextWithoutTools(),
      parts: [
        {
          type: "text",
          text: "Run the shell command `cat a.txt` and tell me its output in one word.",
        },
      ],
      model: { providerID: "opencode", modelID: "big-pickle" },
      variant: "high",
    });
    expect(fake.sent("POST /session")[0]?.body).toEqual({ permission: rulesetFor("supervised") });

    const [approval] = ofTag(events, "ApprovalRequested");
    expect(approval).toMatchObject({ turnId: "turn-1", kind: "command", title: "cat a.txt" });
    const [reply] = fake.sent("POST /permission/per_0eb8ef5fe001fQs75d5yCpvBW2/reply");
    expect(reply?.body).toEqual({ reply: "once" });

    // Polaris answered it itself, so its `permission.replied` is not a withdrawal.
    expect(ofTag(events, "ApprovalWithdrawn")).toEqual([]);
    expect(ofTag(events, "TurnStarted")).toEqual([]);
    expect(events[0]).toEqual(HarnessEvent.CursorAssigned({ cursor: sessionId }));

    const running = ofTag(events, "ItemUpdated").map((e) => e.item);
    expect(
      running.some((item) => TurnItem.guards.CommandExecution(item) && item.status === "running")
    ).toBe(true);

    const completed = ofTag(events, "ItemCompleted").map((e) => e.item);
    expect(completed).toEqual([
      TurnItem.cases.CommandExecution.make({
        id: "prt_0eb8ef590001x99TC4MYhQBkiM",
        command: "cat a.txt",
        cwd: CWD,
        output: "hi\n",
        exitCode: 0,
        status: "completed",
      }),
      TurnItem.cases.AssistantMessage.make({ id: "prt_0eb8f820d001Yb12pW72vxTNH6", text: "hi" }),
    ]);
    expect(ofTag(events, "ItemDelta")).toEqual([
      HarnessEvent.ItemDelta({
        turnId: TurnId.make("turn-1"),
        itemId: "prt_0eb8f820d001Yb12pW72vxTNH6",
        field: "text",
        text: "hi",
      }),
    ]);
    expect(ofTag(events, "TurnEnded")).toEqual([
      HarnessEvent.TurnEnded({ turnId: TurnId.make("turn-1"), status: "completed", error: null }),
    ]);
    // Closing the session ends the stream cleanly.
    expect(events.at(-1)).toEqual(HarnessEvent.Exited({ error: null }));
  });

  test("a Turn typed in the attached terminal is announced with its prompt", async () => {
    const { events } = await withSession(({ emit, waitFor }) =>
      Effect.gen(function* () {
        emit(ev.user("msg_u1"), ev.userText("msg_u1", "fix the tests"), ev.status("busy"));
        emit(
          ev.assistant("msg_a1"),
          ev.reasoning("msg_a1", "prt_r1", "thinking"),
          ev.text("msg_a1", "prt_t1", "done")
        );
        emit(ev.status("idle"), ev.idle());
        yield* waitFor("TurnEnded");
      })
    );

    const [started] = ofTag(events, "TurnStarted");
    expect(started?.prompt).toBe("fix the tests");
    const turnId = started?.turnId ?? TurnId.make("?");
    expect(
      ofTag(events, "ItemCompleted").map((e): ReadonlyArray<string> => [e.turnId, e.item._tag])
    ).toEqual([
      [turnId, "Reasoning"],
      [turnId, "AssistantMessage"],
    ]);
    expect(ofTag(events, "TurnEnded")).toEqual([
      HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }),
    ]);
  });

  test("steer joins the Turn in flight, with the Turn's Model and its image; no second Turn starts", async () => {
    const png = new Attachment({
      id: AttachmentId.make("a1"),
      name: "shot.png",
      mimeType: "image/png",
      size: 4,
      hostPath: "/stage/shot.png",
      width: null,
      height: null,
    });

    const { events, fake } = await withSession(({ session, emit, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn(turnInput("turn-1", "long task", "openai/gpt-5.5", "low"));
        emit(ev.user("msg_u1"), ev.userText("msg_u1", "long task"), ev.status("busy"));
        yield* session.steer("also add docs", [png]);
        emit(ev.user("msg_u2"), ev.userText("msg_u2", "also add docs"));
        emit(ev.assistant("msg_a1"), ev.text("msg_a1", "prt_t1", "ok"), ev.idle());
        yield* waitFor("TurnEnded");

        return yield* Effect.flip(session.steer("too late"));
      })
    );

    const prompts = fake.sent(`POST /session/${FAKE_SESSION_ID}/prompt_async`).map((r) => r.body);
    expect(prompts[1]).toEqual({
      parts: [
        { type: "text", text: "also add docs" },
        {
          type: "file",
          mime: "image/png",
          filename: "shot.png",
          url: Bun.pathToFileURL(png.hostPath).href,
        },
      ],
      model: { providerID: "openai", modelID: "gpt-5.5" },
      variant: "low",
    });
    expect(
      ofTag(events, "ItemCompleted").flatMap((e) =>
        TurnItem.guards.UserMessage(e.item) ? [e.item] : []
      )
    ).toMatchObject([{ text: "also add docs", attachments: [png] }]);
    expect(ofTag(events, "TurnStarted")).toEqual([]);
    expect(ofTag(events, "TurnEnded")).toHaveLength(1);
  });

  test("interrupt aborts; the Turn ends interrupted and its open approval is withdrawn", async () => {
    const { events, fake } = await withSession(({ session, emit, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn(turnInput("turn-1", "edit things"));
        emit(
          ev.user("msg_u1"),
          ev.status("busy"),
          ev.permission("per_1", "edit", ["src/a.ts"], { filepath: "src/a.ts", diff: "+x" })
        );
        const approval = yield* waitFor("ApprovalRequested");
        expect(approval).toMatchObject({
          kind: "file-change",
          title: "Edit src/a.ts",
          detail: "+x",
        });
        yield* session.interrupt;
        emit(
          ev.permissionReplied("per_1", "reject"),
          ev.error("MessageAbortedError", "Aborted"),
          ev.status("idle"),
          ev.idle(),
          ev.idle()
        );
        yield* waitFor("TurnEnded");
        // A stale idle after the next Turn was sent doesn't end it.
        yield* session.sendTurn(turnInput("turn-2", "again"));
        emit(ev.idle());
        yield* Effect.sleep("50 millis");
      })
    );

    expect(fake.sent(`POST /session/${FAKE_SESSION_ID}/abort`)).toHaveLength(1);
    expect(ofTag(events, "ApprovalWithdrawn")).toHaveLength(1);
    expect(ofTag(events, "TurnEnded")).toEqual([
      HarnessEvent.TurnEnded({ turnId: TurnId.make("turn-1"), status: "interrupted", error: null }),
    ]);
    expect(ofTag(events, "ItemCompleted")).toEqual([]);
  });

  test("an approval answered in the terminal is withdrawn; answering it after fails", async () => {
    const { result, events } = await withSession(({ session, emit, waitFor }) =>
      Effect.gen(function* () {
        emit(
          ev.user("msg_u1"),
          ev.userText("msg_u1", "run it"),
          ev.permission("per_1", "bash", ["ls"], { command: "ls" })
        );
        const approval = yield* waitFor("ApprovalRequested");
        emit(ev.permissionReplied("per_1", "always"));
        yield* waitFor("ApprovalWithdrawn");

        return yield* Effect.flip(session.respond(approval.requestId, allow));
      })
    );

    expect(result.message).toContain("No open OpenCode request");
    expect(ofTag(events, "ApprovalWithdrawn")[0]?.requestId).toBe(
      ofTag(events, "ApprovalRequested")[0]?.requestId ?? RequestId.make("?")
    );
  });

  test("questions: options shown, answered with text or rejected", async () => {
    const { fake } = await withSession(({ session, emit, waitFor }) =>
      Effect.gen(function* () {
        emit(
          ev.user("msg_u1"),
          ev.question("que_1", [{ question: "Which database?", options: ["SQLite", "Postgres"] }])
        );
        const first = yield* waitFor("ApprovalRequested");
        expect(first).toMatchObject({
          kind: "question",
          title: "Which database?",
          options: ["SQLite", "Postgres"],
        });
        yield* session.respond(
          first.requestId,
          ApprovalDecision.cases.Answer.make({ text: "DuckDB" })
        );
        emit(ev.question("que_2", [{ question: "Proceed?", options: ["Yes"] }]));
        const second = yield* waitFor("ApprovalRequested", (e) => e.title === "Proceed?");
        yield* session.respond(
          second.requestId,
          ApprovalDecision.cases.Deny.make({ reason: null })
        );
      })
    );

    expect(fake.sent("POST /question/que_1/reply")[0]?.body).toEqual({ answers: [["DuckDB"]] });
    expect(fake.sent("POST /question/que_2/reject")).toHaveLength(1);
  });

  test("resume rejoins a Turn running in the terminal and its pending approval", async () => {
    const { events, fake } = await withSession(
      ({ emit, waitFor }) =>
        Effect.gen(function* () {
          yield* waitFor("ApprovalRequested");
          emit(ev.assistant("msg_a1"), ev.text("msg_a1", "prt_t1", "resumed"), ev.idle());
          yield* waitFor("TurnEnded");
        }),
      {
        resumeCursor: FAKE_SESSION_ID,
        permissionMode: "auto-edits",
        setup: (fake) => {
          fake.respond("GET /session/status", () => ({ [FAKE_SESSION_ID]: { type: "busy" } }));
          fake.respond("GET /permission", () => [
            ev.permission("per_9", "bash", ["make"], { command: "make" }).properties,
            eventsFor("ses_other").permission("per_x", "bash", ["x"]).properties,
          ]);
        },
      }
    );

    expect(fake.sent("POST /session")).toEqual([]);
    expect(fake.sent(`PATCH /session/${FAKE_SESSION_ID}`)[0]?.body).toEqual({
      permission: rulesetFor("auto-edits"),
    });
    const [started] = ofTag(events, "TurnStarted");
    expect(started?.prompt).toBeNull();
    const approvals = ofTag(events, "ApprovalRequested");
    expect(approvals.map((a): ReadonlyArray<string> => [a.turnId, a.title])).toEqual([
      [started?.turnId ?? "", "make"],
    ]);
    expect(ofTag(events, "TurnEnded")[0]).toMatchObject({
      turnId: started?.turnId,
      status: "completed",
    });
  });

  test("a provider error fails the Turn with an Error item", async () => {
    const { events } = await withSession(({ session, emit, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn(turnInput("turn-1", "hi"));
        emit(
          ev.user("msg_u1"),
          ev.status("busy"),
          ev.error("APIError", "OpenCode 1.18.0 or newer is required"),
          ev.idle()
        );
        yield* waitFor("TurnEnded");
      })
    );

    expect(ofTag(events, "ItemCompleted")[0]?.item).toEqual(
      TurnItem.cases.Error.make({
        id: "turn-1:error:1",
        message: "OpenCode 1.18.0 or newer is required",
      })
    );
    expect(ofTag(events, "TurnEnded")[0]).toMatchObject({
      status: "failed",
      error: "OpenCode 1.18.0 or newer is required",
    });
  });

  test("titles, plans and other sessions' events", async () => {
    const other = eventsFor("ses_other");

    const { events } = await withSession(({ session, emit, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn(turnInput("turn-1", "plan it"));
        emit(other.user("msg_x"), other.userText("msg_x", "not ours"), other.idle());
        emit(
          ev.title("New session - 2026-09-29T05:00:00.000Z"),
          ev.user("msg_u1"),
          ev.status("busy")
        );
        emit(
          ev.tool("msg_a1", "prt_todo", "todowrite", {
            status: "completed",
            input: {
              todos: [
                { content: "write it", status: "in_progress" },
                { content: "test it", status: "pending" },
              ],
            },
            output: "",
            metadata: {},
          }),
          ev.title("Plan the migration"),
          ev.idle()
        );
        yield* waitFor("TurnEnded");
      })
    );

    expect(ofTag(events, "TitleSuggested")).toEqual([
      HarnessEvent.TitleSuggested({ title: "Plan the migration" }),
    ]);

    const plan = TurnItem.cases.Plan.make({
      id: "turn-1:plan",
      steps: [
        { text: "write it", status: "in-progress", detail: null },
        { text: "test it", status: "pending", detail: null },
      ],
      explanation: null,
    });

    expect(ofTag(events, "ItemUpdated").map((e) => e.item)).toEqual([plan]);
    expect(ofTag(events, "ItemCompleted").map((e) => e.item)).toEqual([plan]);
    expect(ofTag(events, "TurnStarted")).toEqual([]);
  });

  test("permission modes, Model ids and one Turn at a time", async () => {
    const { result, fake } = await withSession(
      ({ session }) =>
        Effect.gen(function* () {
          yield* session.setPermissionMode("full-access");

          const badModel = yield* Effect.flip(
            session.sendTurn(turnInput("turn-1", "x", "gpt-5.5"))
          );

          yield* session.sendTurn(turnInput("turn-2", "x"));
          const busy = yield* Effect.flip(session.sendTurn(turnInput("turn-3", "y")));
          const terminal = yield* session.terminalCommand;

          return { badModel: badModel.message, busy: busy.message, terminal };
        }),
      { model: "anthropic/claude-sonnet-5-5" }
    );

    expect(fake.sent("POST /session")[0]?.body).toEqual({
      permission: rulesetFor("supervised"),
      model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
    });
    expect(fake.sent(`PATCH /session/${FAKE_SESSION_ID}`)[0]?.body).toEqual({
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });
    expect(result.badModel).toContain("isn't an OpenCode Model id");
    expect(result.busy).toContain("already in progress");
    expect(result.terminal).toEqual([
      "/bin/sh",
      "-c",
      'OPENCODE_SERVER_PASSWORD="$(cat "$1")" exec "$2" attach "$3" --session "$4" --dir "$5"',
      "opencode-attach",
      "/home/user/.polaris/opencode-server.password",
      "/usr/local/bin/opencode",
      fake.url,
      FAKE_SESSION_ID,
      CWD,
    ]);
    expect(result.terminal.join(" ")).not.toContain(fake.password);
  });

  const agentOf = Schema.decodeUnknownSync(
    Schema.Struct({ agent: Schema.optionalKey(Schema.String) })
  );

  test("a planning session prompts OpenCode's plan agent, asking before edits; leaving plan drops it", async () => {
    const { fake } = await withSession(
      ({ session }) =>
        Effect.gen(function* () {
          yield* session.sendTurn(turnInput("turn-1", "how would you fix it?"));
          yield* session.setPermissionMode("auto-edits");
          yield* session.steer("go ahead");
        }),
      { permissionMode: "plan" }
    );

    expect(fake.sent("POST /session")[0]?.body).toEqual({ permission: rulesetFor("supervised") });

    const agents = fake
      .sent(`POST /session/${FAKE_SESSION_ID}/prompt_async`)
      .map((r) => agentOf(r.body).agent ?? null);

    expect(agents).toEqual(["plan", null]);
  });

  test("a server that goes away ends the session with an error", async () => {
    const { events } = await withSession(({ fake, waitFor }) =>
      Effect.gen(function* () {
        fake.dropEvents();
        yield* waitFor("Exited");
      })
    );

    expect(ofTag(events, "Exited")).toEqual([
      HarnessEvent.Exited({ error: "the OpenCode server closed the connection" }),
    ]);
  });

  test("resuming a session OpenCode no longer has fails", async () => {
    const fake = makeFakeServer();
    cleanup.push(fake.stop);
    fake.respond(
      `GET /session/${FAKE_SESSION_ID}`,
      () => new Response("not found", { status: 404 })
    );

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          openSession(fake.asServer(), {
            sessionId: SessionId.make("s1"),
            cwd: CWD,
            permissionMode: "supervised",
            model: null,
            effort: null,
            resumeCursor: FAKE_SESSION_ID,
          })
        )
      )
    );

    expect(error.message).toContain("404");
  });
});

describe("OpenCode Models and probe", () => {
  test("listModels asks the server's providers; keys and options are never read", async () => {
    const fake = makeFakeServer();
    cleanup.push(fake.stop);
    fake.respond("GET /config", () => ({ model: "openai/gpt-5.5" }));
    fake.respond("GET /config/providers", () => ({
      providers: [
        {
          id: "opencode",
          name: "OpenCode Zen",
          source: "custom",
          env: [],
          options: {},
          models: {
            "big-pickle": { id: "big-pickle", name: "Big Pickle", status: "active", variants: {} },
          },
        },
        {
          id: "openai",
          name: "OpenAI",
          source: "custom",
          env: ["OPENAI_API_KEY"],
          key: "sk-secret",
          options: { apiKey: "sk-secret" },
          models: {
            "gpt-5.5": {
              id: "gpt-5.5",
              name: "GPT-5.5",
              variants: { low: {}, medium: {}, high: {} },
            },
            "gpt-4": { id: "gpt-4", name: "GPT-4", status: "deprecated" },
          },
        },
      ],
      default: { opencode: "big-pickle", openai: "gpt-5.5" },
    }));
    const dir = mkdtempSync(join(tmpdir(), "polaris-opencode-models-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const models = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeOpenCodeDriver({
            opencodePath: () => null,
            server: fake.asServer(),
            modelsDirectory: dir,
          });

          return yield* driver.listModels ?? Effect.succeed([]);
        })
      )
    );

    expect(fake.sent("GET /config/providers")[0]?.directory).toBe(dir);
    expect(models.map((m) => [m.id, m.efforts, m.isDefault])).toEqual([
      ["opencode/big-pickle", [], false],
      ["openai/gpt-5.5", ["low", "medium", "high"], true],
    ]);
    expect(JSON.stringify(models)).not.toContain("sk-secret");
  });

  test("probe runs --version only, with throwaway XDG directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-opencode-probe-test-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const bin = shellFake(
      dir,
      "opencode",
      `echo "$@|$XDG_DATA_HOME" >> "${shPath(dir)}/calls"\necho 1.18.33`
    );

    const probe = await Effect.runPromise(probeOpenCode(bin));

    expect(probe).toEqual({ available: true, version: "1.18.33", detail: bin });
    const [call] = (await Bun.file(join(dir, "calls")).text()).trim().split("\n");
    expect(call?.startsWith("--version|")).toBe(true);
    expect(call).toContain("polaris-opencode-probe-");
    expect(await Effect.runPromise(probeOpenCode(null))).toMatchObject({ available: false });
  });
});
