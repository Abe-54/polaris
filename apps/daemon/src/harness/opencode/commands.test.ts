import { afterEach, describe, expect, test } from "bun:test";
import { SessionId, TurnId } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { slashCommandOf, toCommand } from "./commands.ts";
import type * as P from "./protocol.ts";
import { makeOpenCodeDriver } from "./OpenCodeDriver.ts";
import { openSession } from "./OpenCodeSession.ts";
import { FAKE_SESSION_ID, type FakeServer, makeFakeServer } from "./testing/FakeServer.ts";

const CWD = "/repo";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const COMMANDS = [
  { name: "ship", description: "Ship it", source: "command", template: "Ship $1", hints: ["$1"] },
  { name: "tidy", source: "skill", template: "Tidy up", hints: [] },
  { name: "docs", source: "mcp", template: "", hints: ["$ARGUMENTS"] },
] satisfies ReadonlyArray<typeof P.Command.Type>;

const fakeWithCommands = () => {
  const fake = makeFakeServer();
  cleanup.push(fake.stop);
  fake.respond("GET /command", () => COMMANDS);

  return fake;
};

const turn = (prompt: string) => ({
  turnId: TurnId.make("turn-1"),
  prompt,
  attachments: [],
  model: "openai/gpt-5.5",
  effort: "high",
});

/** Sends `prompt` in a session against `fake`; returns the session's events. */
const sendIn = (fake: FakeServer, prompt: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<HarnessEvent> = [];

        const session = yield* openSession(fake.asServer("/tmp/none.password"), {
          sessionId: SessionId.make("s1"),
          cwd: CWD,
          permissionMode: "supervised",
          model: null,
          effort: null,
          resumeCursor: null,
        });

        yield* session.events.pipe(
          Stream.runForEach((e) => Effect.sync(() => events.push(e))),
          Effect.forkDetach
        );
        yield* session.sendTurn(turn(prompt));
        yield* Effect.promise(() => Bun.sleep(50));

        return events;
      })
    )
  );

describe("OpenCode's commands", () => {
  test("listed from GET /command in the directory after /compact: Skills first, hints as the argument hint", async () => {
    const fake = fakeWithCommands();

    const listed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeOpenCodeDriver({
            opencodePath: () => null,
            server: fake.asServer(),
          });

          return yield* driver.listCommands?.(CWD) ?? Effect.succeed([]);
        })
      )
    );

    expect(fake.sent("GET /command")[0]?.directory).toBe(CWD);
    expect(listed.map((c) => [c.name, c.kind, c.argumentHint, c.run])).toEqual([
      ["compact", "command", null, "harness"],
      ["tidy", "skill", null, "text"],
      ["docs", "command", "$ARGUMENTS", "text"],
      ["ship", "command", "$1", "text"],
    ]);
    expect(COMMANDS.map(toCommand)[1]?.description).toBe("");
  });

  test("a prompt names a command only as `/name`, at the start", () => {
    const commands = COMMANDS;
    expect(slashCommandOf(" /ship main now", commands)).toEqual({
      command: "ship",
      arguments: "main now",
    });
    expect(slashCommandOf("/tidy", commands)).toEqual({ command: "tidy", arguments: "" });
    expect(slashCommandOf("/nope", commands)).toBeNull();
    expect(slashCommandOf("please /ship", commands)).toBeNull();
  });

  test("a Turn naming a command runs it through /command with the Turn's Model", async () => {
    const fake = fakeWithCommands();
    fake.respond(`POST /session/${FAKE_SESSION_ID}/command`, () => ({ info: {}, parts: [] }));

    await sendIn(fake, "/ship main");

    expect(fake.sent(`POST /session/${FAKE_SESSION_ID}/command`)[0]?.body).toEqual({
      command: "ship",
      arguments: "main",
      model: "openai/gpt-5.5",
      variant: "high",
    });
    expect(fake.sent(`POST /session/${FAKE_SESSION_ID}/prompt_async`)).toHaveLength(0);
  });

  test("a command OpenCode refuses before starting fails the Turn", async () => {
    const fake = fakeWithCommands();
    fake.respond(
      `POST /session/${FAKE_SESSION_ID}/command`,
      () => new Response("no such agent", { status: 400 })
    );

    const events = await sendIn(fake, "/ship main");

    const ended = events.filter(HarnessEvent.$is("TurnEnded"));
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ turnId: "turn-1", status: "failed" });
  });

  test("any other prompt, slash or not, is sent as text", async () => {
    const fake = fakeWithCommands();

    await sendIn(fake, "/etc/hosts is broken");

    expect(fake.sent(`POST /session/${FAKE_SESSION_ID}/prompt_async`)).toHaveLength(1);
    expect(fake.sent(`POST /session/${FAKE_SESSION_ID}/command`)).toHaveLength(0);
  });
});
