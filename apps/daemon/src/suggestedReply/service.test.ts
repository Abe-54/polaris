import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  DomainEvent,
  PlanLimit,
  SuggestedReplyFallback,
  SuggestedReplySettings,
  TurnItem,
  type Turn,
} from "@polaris/protocol";
import { type Duration, Effect, Layer, Stream } from "effect";
import { Availability } from "../harness/availability/Availability.ts";
import { HarnessError } from "../harness/HarnessDriver.ts";
import type { StructuredJob } from "../inline/structured.ts";
import { tempDir } from "../platform/tempDir.testing.ts";
import { suggestReply } from "../engine/suggestedReplies.ts";
import { EventStore } from "../store/EventStore.ts";
import { UsageIndex } from "../usage/service.ts";
import type { ReplyBackend } from "./backend.ts";
import { SUGGEST_TIMEOUT, SuggestedReplies } from "./service.ts";
import { agentSession, at, report, sessionId, turn, workspace } from "./testing.ts";

interface Call {
  readonly harness: string;
  readonly job: StructuredJob;
  interrupted: boolean;
}

/** Answers with `answer`, after `hang` never; records each call and whether it was cut off. */
const scripted = (answer: Effect.Effect<{ reply: string | null }, HarnessError>) => {
  const calls: Array<Call> = [];

  const backend: ReplyBackend = (harness, job) => {
    const call: Call = { harness, job, interrupted: false };
    calls.push(call);

    return answer.pipe(Effect.onInterrupt(() => Effect.sync(() => (call.interrupted = true))));
  };

  return { calls, backend };
};

const enabled = SuggestedReplySettings.make({ enabled: true, fallback: null });

const limitOf = (harness: "claude" | "codex", status: "warning" | "reached") =>
  new PlanLimit({
    harness,
    kind: "five-hour",
    scope: null,
    windowMinutes: 300,
    usedPercent: 26,
    status,
    resetsAt: null,
    observedAt: at,
    plan: null,
  });

/** How often each check the service makes was read: the last one it reached shows it decided. */
const reads = { settings: 0, availability: 0, limits: 0 };

const counted = <A>(key: keyof typeof reads, value: A) =>
  Effect.sync(() => {
    reads[key]++;

    return value;
  });

const usageWith = (limits: ReadonlyArray<PlanLimit>) =>
  Layer.succeed(UsageIndex)(
    UsageIndex.of({
      refresh: () => Effect.void,
      query: () => Effect.die("unused"),
      responses: () => Effect.die("unused"),
      changes: Stream.empty,
      planLimits: counted("limits", limits),
    })
  );

type Ready = ReadonlyArray<"claude" | "codex">;

/** `cached` is the report from before a sign-in; asking for a current one gets `ready`. */
const availabilityOf = (ready: Ready, cached: Ready = ready) =>
  Layer.succeed(Availability)(
    Availability.of({
      get: (refresh) =>
        counted("availability", refresh === false ? report(...cached) : report(...ready)),
      changes: Stream.empty,
    })
  );

const commitAll = (events: ReadonlyArray<DomainEvent>) =>
  Effect.flatMap(EventStore, (store) =>
    store.commit({ commandId: null, decide: () => Effect.succeed(events) })
  );

const started = (t: Turn) => DomainEvent.cases.TurnStarted.make({ turn: t });

const ended = (t: Turn) => DomainEvent.cases.TurnEnded.make({ turn: t });

const said = (t: Turn, text: string) =>
  DomainEvent.cases.TurnItemCompleted.make({
    sessionId,
    turnId: t.id,
    item: TurnItem.cases.AssistantMessage.make({ id: `m-${t.id}`, text }),
    subagentId: null,
  });

/** A Codex session whose first Turn ended and whose second is working. */
const seed = commitAll([
  DomainEvent.cases.WorkspaceRegistered.make({ workspace }),
  DomainEvent.cases.SessionCreated.make({ session: agentSession() }),
  started(turn(0, "working")),
  said(turn(0), "Which file?"),
  ended(turn(0)),
  started(turn(1, "working", "the parser")),
  said(turn(1), "Fixed the parser. Want me to add a test?"),
]);

const suggestion = Effect.map(EventStore, (store) =>
  Effect.map(store.model, (model) => model.sessions.get(sessionId)?.session.suggestedReply)
).pipe(Effect.flatten);

const eventually = <A>(read: Effect.Effect<A, never, EventStore>, ok: (a: A) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200; tries++) {
      const value = yield* read;

      if (ok(value)) return value;
      yield* Effect.sleep("10 millis");
    }

    return yield* read;
  });

const run = <A, E>(
  options: {
    backend: ReplyBackend;
    settings?: SuggestedReplySettings;
    ready?: Ready;
    cached?: Ready;
    limits?: ReadonlyArray<PlanLimit>;
    timeout?: Duration.Input;
  },
  program: Effect.Effect<A, E, EventStore | SuggestedReplies>
) => {
  const store = EventStore.layerSqlite(join(tempDir("polaris-suggested-"), "state.sqlite"));

  reads.settings = reads.availability = reads.limits = 0;

  // The Engine's own decision commits the offer, as `Engine.offerSuggestedReply` does.
  const fallback = Layer.unwrap(
    Effect.map(EventStore, (events) =>
      SuggestedReplies.layerWith({
        settings: counted("settings", options.settings ?? enabled),
        offer: (session, turnId, text, source) =>
          events
            .commit({
              commandId: null,
              decide: (model) => {
                const found = model.sessions.get(session);

                return Effect.succeed(
                  found === undefined ? [] : suggestReply(found, turnId, text, source)
                );
              },
            })
            .pipe(Effect.asVoid),
        backend: options.backend,
        timeout: options.timeout ?? SUGGEST_TIMEOUT,
      })
    )
  );

  const layer = fallback.pipe(
    Layer.provideMerge(store),
    Layer.provide(availabilityOf(options.ready ?? ["codex"], options.cached)),
    Layer.provide(usageWith(options.limits ?? []))
  );

  return Effect.runPromise(Effect.andThen(seed, program).pipe(Effect.provide(layer)));
};

const settled = Effect.flatMap(SuggestedReplies, (s) => eventually(s.inFlight, (n) => n === 0));

test("a completed Turn gets the fallback's reply as a Polaris suggestion", async () => {
  const { calls, backend } = scripted(Effect.succeed({ reply: " Yes, add one. " }));

  const reply = await run(
    { backend },
    Effect.andThen(
      commitAll([ended(turn(1))]),
      eventually(suggestion, (s) => s != null)
    )
  );

  expect(reply).toMatchObject({ turnId: turn(1).id, text: "Yes, add one.", source: "polaris" });
  expect(calls[0]?.harness).toBe("codex");
  expect(calls[0]?.job.prompt).toContain("Agent: Fixed the parser. Want me to add a test?");
  expect(calls[0]?.job.prompt).toContain("User: ask 0");
});

test("the Settings fallback's Model and effort are the ones asked", async () => {
  const { calls, backend } = scripted(Effect.succeed({ reply: "ok" }));

  const settings = SuggestedReplySettings.make({
    enabled: true,
    fallback: SuggestedReplyFallback.make({ harness: "claude", model: "m-1", effort: "low" }),
  });

  await run(
    { backend, settings, ready: ["claude", "codex"] },
    Effect.andThen(
      commitAll([ended(turn(1))]),
      eventually(suggestion, (s) => s != null)
    )
  );

  expect(calls.map((c) => [c.harness, c.job.model, c.job.effort])).toEqual([
    ["claude", "m-1", "low"],
  ]);
});

test("a Harness signed in after the Daemon's cached report still writes the suggestion", async () => {
  const { calls, backend } = scripted(Effect.succeed({ reply: "Keep the repo style." }));

  const reply = await run(
    { backend, cached: [], ready: ["codex"] },
    Effect.andThen(
      commitAll([ended(turn(1))]),
      eventually(suggestion, (s) => s != null)
    )
  );

  expect(reply?.text).toBe("Keep the repo style.");
  expect(calls.map((c) => c.harness)).toEqual(["codex"]);
});

test("a Plan Limit warning, as Claude sends for a fast pace at low use, still gets a suggestion", async () => {
  const { calls, backend } = scripted(Effect.succeed({ reply: "Commit it." }));

  const reply = await run(
    { backend, limits: [limitOf("codex", "warning"), limitOf("claude", "warning")] },
    Effect.andThen(
      commitAll([ended(turn(1))]),
      eventually(suggestion, (s) => s != null)
    )
  );

  expect(reply?.text).toBe("Commit it.");
  expect(calls).toHaveLength(1);
});

test("a 'nothing' answer commits nothing", async () => {
  const { calls, backend } = scripted(Effect.succeed({ reply: null }));

  const reply = await run(
    { backend },
    Effect.gen(function* () {
      yield* commitAll([ended(turn(1))]);
      yield* eventually(
        Effect.sync(() => calls.length),
        (n) => n === 1
      );
      yield* settled;

      return yield* suggestion;
    })
  );

  expect(reply).toBeNull();
});

test("a new Turn cancels the suggestion being written", async () => {
  const { calls, backend } = scripted(Effect.never);

  // Read before the Layer closes, which would interrupt it anyway.
  const [interrupted, reply] = await run(
    { backend },
    Effect.gen(function* () {
      yield* commitAll([ended(turn(1))]);
      yield* eventually(
        Effect.sync(() => calls.length),
        (n) => n === 1
      );
      yield* commitAll([started(turn(2, "working"))]);

      return [
        yield* eventually(
          Effect.sync(() => calls[0]?.interrupted === true),
          Boolean
        ),
        yield* suggestion,
      ] as const;
    })
  );

  expect(interrupted).toBe(true);
  expect(reply).toBeNull();
});

test("a fallback past the timeout is dropped, silently, and the next Turn still gets one", async () => {
  let answer: Effect.Effect<{ reply: string | null }, HarnessError> = Effect.never;
  const { calls, backend } = scripted(Effect.suspend(() => answer));

  const reply = await run(
    { backend, timeout: "50 millis" },
    Effect.gen(function* () {
      yield* commitAll([ended(turn(1))]);

      // The timeout, not the next Turn, cuts it off.
      const cut = yield* eventually(
        Effect.sync(() => calls[0]?.interrupted === true),
        Boolean
      );

      expect(cut).toBe(true);
      yield* settled;
      expect(yield* suggestion).toBeNull();

      answer = Effect.succeed({ reply: "Next." });
      yield* commitAll([started(turn(2, "working")), ended(turn(2))]);

      return yield* eventually(suggestion, (s) => s != null);
    })
  );

  expect(reply?.text).toBe("Next.");
});

test("a failing Harness commits nothing and the service keeps following", async () => {
  let answer: Effect.Effect<{ reply: string | null }, HarnessError> = Effect.fail(
    new HarnessError({ harness: "codex", message: "signed out" })
  );

  const { calls, backend } = scripted(Effect.suspend(() => answer));

  const reply = await run(
    { backend },
    Effect.gen(function* () {
      yield* commitAll([ended(turn(1))]);
      yield* eventually(
        Effect.sync(() => calls.length),
        (n) => n === 1
      );
      yield* settled;
      expect(yield* suggestion).toBeNull();

      answer = Effect.succeed({ reply: "Again." });
      yield* commitAll([started(turn(2, "working")), ended(turn(2))]);

      return yield* eventually(suggestion, (s) => s != null);
    })
  );

  expect(reply?.text).toBe("Again.");
});

test.each([
  ["the preference is off", "settings", { settings: SuggestedReplySettings.make({}) }],
  [
    "the fallback's Harness has reached a Plan Limit",
    "limits",
    { limits: [limitOf("codex", "reached")] },
  ],
  ["no fallback Harness is ready", "availability", { ready: [] }],
] as const)("nothing runs when %s", async (_, decided, options) => {
  const { calls, backend } = scripted(Effect.succeed({ reply: "never" }));

  const reply = await run(
    { backend, ...options },
    Effect.gen(function* () {
      yield* commitAll([ended(turn(1))]);
      yield* eventually(
        Effect.sync(() => reads[decided]),
        (n) => n > 0
      );
      yield* settled;

      return yield* suggestion;
    })
  );

  expect(calls).toEqual([]);
  expect(reply).toBeNull();
});
