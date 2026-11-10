import { describe, expect, test } from "bun:test";
import { SessionId, TurnId } from "@polaris/protocol";
import { Effect, Exit, Scope, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { FakeClaude, result } from "./fakeClaude.ts";

const T1 = TurnId.make("turn-1");

const T2 = TurnId.make("turn-2");

const suggestion = (text: string) => ({
  type: "prompt_suggestion" as const,
  suggestion: text,
  uuid: crypto.randomUUID(),
  session_id: "claude-session-1",
});

/** A Claude session whose Suggested Replies preference the test flips through `pref.on`. */
const openWith = async (on: boolean) => {
  const pref = { on };
  const fake = new FakeClaude();

  const driver = makeClaudeDriver({
    query: fake.query,
    claudePath: () => "/opt/bin/claude",
    stagingDir: "/tmp/polaris-staging",
    suggestedReplies: () => pref.on,
  });

  const scope = Effect.runSync(Scope.make());

  const session = await Effect.runPromise(
    driver
      .open({
        sessionId: SessionId.make("session-1"),
        cwd: "/work/repo",
        permissionMode: "supervised",
        model: null,
        effort: null,
        resumeCursor: null,
      })
      .pipe(Scope.provide(scope))
  );

  const events: HarnessEvent[] = [];
  Effect.runFork(Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e))));

  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 400 && !predicate(); i++) await Bun.sleep(2);

    if (!predicate()) throw new Error(`timed out; events: ${JSON.stringify(events)}`);
  };

  const ended = (turnId: TurnId) => () =>
    events.some((e) => HarnessEvent.$is("TurnEnded")(e) && e.turnId === turnId);

  /** Runs a Turn to its `result`; resolves once the driver reported it ended. */
  const runTurn = async (turnId: TurnId, n: number) => {
    await Effect.runPromise(
      session.sendTurn({ turnId, prompt: "go", attachments: [], model: null, effort: null })
    );
    const sent = await fake.nextInput(n);
    fake.emit(result([sent.uuid!]));
    await until(ended(turnId));
  };

  const suggested = () => events.filter(HarnessEvent.$is("ReplySuggested"));

  return {
    pref,
    fake,
    until,
    session,
    runTurn,
    ended,
    suggested,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

describe("Claude Code Suggested Replies", () => {
  test("on: asks Claude Code for suggestions and reports one after the Turn ended", async () => {
    const t = await openWith(true);
    expect(t.fake.options!.promptSuggestions).toBe(true);

    // The Turn ends on `result`, before the suggestion arrives.
    await t.runTurn(T1, 0);
    expect(t.suggested()).toEqual([]);
    t.fake.emit(suggestion("Run the tests again"));
    await t.until(() => t.suggested().length > 0);

    expect(t.suggested()).toMatchObject([{ turnId: T1, text: "Run the tests again" }]);
    await t.close();
  });

  test("off: the option is absent and a suggestion is never reported", async () => {
    const t = await openWith(false);
    expect(t.fake.options!).not.toHaveProperty("promptSuggestions");

    await t.runTurn(T1, 0);
    t.fake.emit(suggestion("Run the tests again"));
    await t.fake.waitProcessed();
    // Events arrive in order: once the next Turn has ended, a suggestion would have shown.
    await t.runTurn(T2, 1);

    expect(t.suggested()).toEqual([]);
    await t.close();
  });

  test("turned off mid-session: the next Turn's suggestion is dropped", async () => {
    const t = await openWith(true);
    t.pref.on = false;

    await t.runTurn(T1, 0);
    t.fake.emit(suggestion("Run the tests again"));
    await t.fake.waitProcessed();
    // Events arrive in order: once the next Turn has ended, a suggestion would have shown.
    await t.runTurn(T2, 1);

    expect(t.suggested()).toEqual([]);
    await t.close();
  });

  test("a suggestion that arrives after a newer Turn started is dropped", async () => {
    const t = await openWith(true);

    await t.runTurn(T1, 0);
    await Effect.runPromise(
      t.session.sendTurn({ turnId: T2, prompt: "next", attachments: [], model: null, effort: null })
    );
    t.fake.emit(suggestion("stale"));
    t.fake.emit(result([(await t.fake.nextInput(1)).uuid!]));
    await t.until(() => t.ended(T2)());

    expect(t.suggested()).toEqual([]);
    await t.close();
  });
});
