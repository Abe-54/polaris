/**
 * Browser hosting against the real Engine predicate (ENG-613): a claim is validated through
 * `Engine.hostableSession`, so a session archived while the claim waits for its connection to
 * register is refused — not a fake boolean, the Daemon's own folded model.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BlobId, Command, SessionId, SessionPlacement } from "@polaris/protocol";
import { Effect, Fiber, type Layer, Scope, Stream } from "effect";
import { makeRepo } from "../git/testing.ts";
import type { BlobChannel } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { Engine } from "../engine/Engine.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
} from "../engine/testing.ts";
import { HostPresence } from "../presence/index.ts";
import { BrowserHosting } from "./hosting.ts";
import { ByteStreamQuota } from "./quota.ts";

type Env = Engine | EventStore;

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer)));

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "MacBook" })
  );

const presence: HostPresence["Service"] = {
  report: () => 0,
  disconnect: () => {},
  present: () => false,
  lastPresentAt: () => null,
  watch: () => () => {},
};

const fakeBlobs: BlobChannel["Service"] = {
  offer: () => Effect.succeed(BlobId.make("blob")),
  take: () => Effect.die("unused"),
  takeStream: () => Stream.never,
};

const eventually = (probe: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !probe(); i++) yield* Effect.sleep("10 millis");

    return probe();
  });

describe("Browser hosting against the real Engine", () => {
  test("a session archived while the claim awaits registration is refused", async () => {
    const claude = makeFakeDriver("claude", { onTurn: completesTurns() });

    const layer = engineLayer({
      filename: join(tempDir(), "state.sqlite"),
      fakes: makeFakes(),
      drivers: [claude],
    });

    const outcome = await run(
      layer,
      Effect.gen(function* () {
        const engine = yield* Engine;
        const repo = yield* Effect.promise(() => makeRepo());

        yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));

        const registered = yield* waitFor(
          (m) => [...m.workspaces.values()].some((w) => w.path === repo),
          10_000
        );

        const workspace = [...registered.workspaces.values()].find((w) => w.path === repo)!;

        const sessionId = SessionId.make("browser-session");

        yield* dispatch(
          Command.cases.StartSession.make({
            sessionId,
            workspaceId: workspace.id,
            harness: "claude",
            placement: SessionPlacement.cases.InPlace.make({}),
            permissionMode: "supervised",
            model: null,
            effort: null,
            prompt: "hello",
            attachments: [],
          })
        );

        yield* waitFor((m) => m.sessions.get(sessionId) !== undefined, 10_000);
        expect(yield* engine.hostableSession(sessionId)).toBe(true);

        const hosting = BrowserHosting.make(
          presence,
          ByteStreamQuota.make(),
          {},
          engine.hostableSession
        );

        // The connection has not registered yet, so the claim parks on the registration wait.
        const claiming = yield* Effect.forkChild(hosting.claim(1, sessionId).pipe(Effect.flip));
        yield* eventually(() => hosting.awaitingClaims(1) === 1);

        // Archive the session mid-wait, then let the connection register: the post-wait recheck
        // must see the archived state and refuse, rather than record a claim for a dead session.
        yield* dispatch(
          Command.cases.ArchiveSession.make({ sessionId, deleteMergedBranch: false })
        );
        yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "archived", 10_000);

        yield* hosting.register(1, fakeBlobs);
        const refused = yield* Fiber.join(claiming);

        return { tag: refused._tag, hostable: yield* engine.hostableSession(sessionId) };
      })
    );

    expect(outcome.tag).toBe("NotFound");
    expect(outcome.hostable).toBe(false);
  }, 15_000);
});
