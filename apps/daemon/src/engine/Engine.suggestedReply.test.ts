import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Command, SessionId, SessionPlacement } from "@polaris/protocol";
import { Effect, type Layer } from "effect";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { EventStore } from "../store/EventStore.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
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

describe("Harness Suggested Replies", () => {
  test("commit for the ended Turn only; a working or older Turn's are dropped", async () => {
    const claude = makeFakeDriver("claude");
    const filename = join(tempDir(), "state.sqlite");
    const layer = engineLayer({ filename, fakes: makeFakes(), drivers: [claude] });

    await run(
      layer,
      Effect.gen(function* () {
        const repo = fakeRepo();
        yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
        const model = yield* waitFor((m) => m.workspaces.size > 0);
        const workspace = [...model.workspaces.values()][0]!;
        const s = SessionId.make("s-suggest");
        yield* dispatch(
          Command.cases.StartSession.make({
            sessionId: s,
            workspaceId: workspace.id,
            harness: "claude",
            placement: SessionPlacement.cases.InPlace.make({}),
            permissionMode: "supervised",
            model: null,
            effort: null,
            prompt: "Fix the flaky test",
            attachments: [],
          })
        );
        yield* waitFor((m) => m.sessions.get(s)?.session.state === "working");
        const harness = claude.latest(s)!;
        const first = harness.turns[0]!.turnId;

        // Harness events are handled in order: a title after it means the suggestion was seen.
        harness.emit(
          HarnessEvent.ReplySuggested({ turnId: first, text: "too early" }),
          HarnessEvent.TitleSuggested({ title: "Mid-Turn" })
        );
        const working = yield* waitFor((m) => m.sessions.get(s)?.session.title === "Mid-Turn");
        expect(working.sessions.get(s)!.session.suggestedReply ?? null).toBeNull();

        harness.emit(
          HarnessEvent.TurnEnded({ turnId: first, status: "completed", error: null }),
          HarnessEvent.ReplySuggested({ turnId: first, text: "Run the tests again" })
        );
        const ended = yield* waitFor((m) => m.sessions.get(s)?.session.suggestedReply != null);
        expect(ended.sessions.get(s)!.session.suggestedReply).toMatchObject({
          turnId: first,
          text: "Run the tests again",
          source: "harness",
        });

        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId: s, prompt: "go", attachments: [] })
        );
        yield* waitFor((m) => m.sessions.get(s)?.session.state === "working");
        harness.emit(
          HarnessEvent.ReplySuggested({ turnId: first, text: "stale" }),
          HarnessEvent.TitleSuggested({ title: "Second" })
        );
        const after = yield* waitFor((m) => m.sessions.get(s)?.session.title === "Second");
        expect(after.sessions.get(s)!.session.suggestedReply ?? null).toBeNull();
      })
    );
  });
});
