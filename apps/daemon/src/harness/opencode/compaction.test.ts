import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { events as eventsFor } from "./testing/events.ts";
import { FAKE_SESSION_ID, type FakeServer } from "./testing/FakeServer.ts";
import { ofTag, stopFakes, turnInput, withSession } from "./testing/FakeServer.ts";

const ev = eventsFor(FAKE_SESSION_ID);

const SUMMARIZE = `POST /session/${FAKE_SESSION_ID}/summarize`;

const MODEL = { providerID: "anthropic", modelID: "claude-fable-5-1" };

const PROVIDERS = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-fable-5-1": { id: "claude-fable-5-1", name: "Fable", limit: { context: 400_000 } },
      },
    },
  ],
  default: { anthropic: "claude-fable-5-1" },
};

const withProviders = (fake: FakeServer) => fake.respond("GET /config/providers", () => PROVIDERS);

afterEach(stopFakes);

/** A Turn whose one model call carried 180k tokens. */
const largeTurn = [
  ev.user("msg_u1"),
  ev.status("busy"),
  ev.assistant("msg_a1", MODEL),
  ev.stepFinish("msg_a1", { input: 2_000, cached: 177_000, output: 1_000 }),
  ev.idle(),
];

/** OpenCode's compaction: a user message with a compaction part, then a summary message. */
const compactionRun = (auto: boolean) => [
  ev.user("msg_c1"),
  ev.compaction("msg_c1", auto),
  ev.status("busy"),
  ev.assistant("msg_s1", { ...MODEL, summary: true }),
  ev.text("msg_s1", "prt_s1", "We were fixing the parser."),
  ev.stepFinish("msg_s1", { input: 180_000, cached: 0, output: 3_200 }),
  ev.compacted(),
];

describe("OpenCode context usage and compaction (ENG-571)", () => {
  test("/compact runs summarize with the session's Model and reports the window it left", async () => {
    const { events, fake } = await withSession(
      ({ session, emit, waitFor }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.sleep(30)); // the Models' windows load aside
          yield* session.sendTurn(turnInput("turn-1", "fix the parser"));
          emit(...largeTurn);
          yield* waitFor("TurnEnded");
          yield* session.sendTurn(turnInput("turn-2", "/compact"));
          emit(...compactionRun(false), ev.idle());
          yield* waitFor("TurnEnded", (e) => e.turnId === "turn-2");
        }),
      { setup: withProviders }
    );

    expect(fake.sent(SUMMARIZE).map((r) => r.body)).toEqual([{ ...MODEL, auto: false }]);
    expect(fake.sent(`POST /session/${FAKE_SESSION_ID}/prompt_async`)).toHaveLength(1);
    expect(ofTag(events, "ContextUsed")).toEqual([
      HarnessEvent.ContextUsed({ usedTokens: 180_000, windowTokens: 400_000 }),
      HarnessEvent.ContextUsed({
        usedTokens: 3_200,
        windowTokens: 400_000,
        compacted: { trigger: "manual", beforeTokens: 180_000, afterTokens: 3_200 },
      }),
    ]);
    expect(ofTag(events, "TurnEnded").at(-1)).toMatchObject({
      turnId: "turn-2",
      status: "completed",
    });
  });

  test("OpenCode compacting a full window on its own is reported as auto", async () => {
    const { events } = await withSession(({ session, emit, waitFor }) =>
      Effect.gen(function* () {
        yield* session.sendTurn(turnInput("turn-1", "keep going", "anthropic/claude-fable-5-1"));
        emit(...largeTurn.slice(0, -1), ...compactionRun(true), ev.idle());
        yield* waitFor("TurnEnded");
      })
    );

    const reports = ofTag(events, "ContextUsed");
    expect(reports.map((e) => e.compacted)).toEqual([
      undefined,
      { trigger: "auto", beforeTokens: 180_000, afterTokens: 3_200 },
    ]);
    // Without the providers' answer the window is unknown, not guessed.
    expect(reports.map((e) => e.windowTokens)).toEqual([null, null]);
  });

  test("/compact on a resumed session with no Turn yet compacts with OpenCode's configured Model", async () => {
    const { fake } = await withSession(
      ({ session }) =>
        Effect.gen(function* () {
          yield* session.sendTurn(turnInput("turn-1", " /compact "));
          yield* Effect.promise(() => Bun.sleep(30));
        }),
      {
        resumeCursor: FAKE_SESSION_ID,
        setup: (fake) => fake.respond("GET /config", () => ({ model: "openai/gpt-5.5" })),
      }
    );

    expect(fake.sent(SUMMARIZE).map((r) => r.body)).toEqual([
      { providerID: "openai", modelID: "gpt-5.5", auto: false },
    ]);
  });

  test("a summarize OpenCode refuses fails the Turn", async () => {
    const { events } = await withSession(
      ({ session, waitFor }) =>
        Effect.gen(function* () {
          yield* session.sendTurn(turnInput("turn-1", "/compact", "openai/gpt-5.5"));
          yield* waitFor("TurnEnded");
        }),
      { setup: (fake) => fake.respond(SUMMARIZE, () => new Response("busy", { status: 400 })) }
    );

    const ended = ofTag(events, "TurnEnded");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ turnId: "turn-1", status: "failed" });
    expect(ofTag(events, "ContextUsed")).toEqual([]);
  });
});
