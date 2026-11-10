import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Command,
  SessionId,
  SessionPlacement,
  SuggestedReplyFallback,
  SuggestedReplySettings,
} from "@polaris/protocol";
import { Effect, Fiber, type Layer, Stream } from "effect";
import type { EventStore } from "../store/EventStore.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
} from "./testing.ts";

type Env = Engine | EventStore;

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "MacBook" })
  );

const startIdleSession = (s: SessionId) =>
  Effect.gen(function* () {
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: fakeRepo(), name: null }));
    const model = yield* waitFor((m) => m.workspaces.size > 0);
    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId: s,
        workspaceId: [...model.workspaces.values()][0]!.id,
        harness: "claude",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "Fix the flaky test",
        attachments: [],
      })
    );

    return yield* waitFor(
      (m) => m.sessions.get(s)?.session.state === "idle" && m.sessions.get(s)!.turns.length === 1
    );
  });

const suggestionOf = (s: SessionId) =>
  waitFor(() => true).pipe(Effect.map((m) => m.sessions.get(s)?.session.suggestedReply ?? null));

describe("Suggested Replies", () => {
  test("a suggestion follows the latest Turn, and a newer Turn makes it stale", async () => {
    const claude = makeFakeDriver("claude", { onTurn: completesTurns() });

    const layer = engineLayer({
      filename: join(tempDir(), "state.sqlite"),
      fakes: makeFakes(),
      drivers: [claude],
    });

    await run(
      layer,
      Effect.gen(function* () {
        const s = SessionId.make("s-suggest");
        const first = (yield* startIdleSession(s)).sessions.get(s)!.turns[0]!;
        const engine = yield* Engine;

        yield* engine.offerSuggestedReply(s, first.id, "  Run the tests  ", "harness");
        yield* waitFor((m) => m.sessions.get(s)?.session.suggestedReply != null);

        expect(yield* suggestionOf(s)).toMatchObject({
          turnId: first.id,
          text: "Run the tests",
          source: "harness",
        });

        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId: s, prompt: "go", attachments: [] })
        );
        yield* waitFor((m) => m.sessions.get(s)!.turns.length === 2);

        expect(yield* suggestionOf(s)).toBeNull();

        // One written for the first Turn that lands after the second started commits nothing.
        const idle = yield* waitFor((m) => m.sessions.get(s)?.session.state === "idle");
        const second = idle.sessions.get(s)!.turns[1]!;
        yield* engine.offerSuggestedReply(s, first.id, "A late reply", "harness");

        expect(yield* suggestionOf(s)).toBeNull();

        // Polaris's fallback commits the same event, for the Turn that is latest now.
        yield* engine.offerSuggestedReply(s, second.id, "Open a pull request", "polaris");
        const after = yield* waitFor((m) => m.sessions.get(s)?.session.suggestedReply != null);

        expect(after.sessions.get(s)!.session.suggestedReply).toMatchObject({
          turnId: second.id,
          source: "polaris",
        });
      })
    );
  });

  test("the preference defaults to off, round-trips, announces changes and survives a restart", async () => {
    const filename = join(tempDir(), "state.sqlite");

    const layer = () =>
      engineLayer({ filename, fakes: makeFakes(), drivers: [makeFakeDriver("claude")] });

    const chosen = SuggestedReplySettings.make({
      enabled: true,
      fallback: SuggestedReplyFallback.make({
        harness: "claude",
        model: "claude-haiku-5-5",
        effort: null,
      }),
    });

    await run(
      layer(),
      Effect.gen(function* () {
        const replies = (yield* Engine).suggestedReplies;
        const before = yield* replies.resolved;

        expect(before.settings.enabled).toBe(false);
        expect(before.resolved.source).toBe("auto");

        const seen = yield* replies.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild
        );

        yield* Effect.yieldNow;
        yield* replies.set(chosen);

        expect([...(yield* Fiber.join(seen))].map((s) => s.enabled)).toEqual([false, true]);
      })
    );

    await run(
      layer(),
      Effect.gen(function* () {
        const after = yield* (yield* Engine).suggestedReplies.resolved;

        expect(after.settings).toEqual(chosen);
        expect(after.resolved).toMatchObject({ choice: chosen.fallback, source: "settings" });
      })
    );
  });
});
