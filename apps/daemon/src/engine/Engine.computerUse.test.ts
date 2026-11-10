import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ApprovalDecision,
  type ApprovalRequest,
  Command,
  type ComputerUseState,
  SessionId,
  SessionPlacement,
} from "@polaris/protocol";
import { Deferred, Effect, Fiber, Layer, Option, Predicate, type Scope, Stream } from "effect";
import { DesktopMcp, type DesktopServer } from "../harness/desktop/index.ts";
import { fakeDeps, fakeHost, fakeRunner, OFF, READY } from "../harness/desktop/testing.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import type { EventStore } from "../store/EventStore.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
  engineLayer,
  type FakeDriver,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "./testing.ts";

type Env = Engine | EventStore;

const CURSOR = "thr_numbers";

/**
 * A fake Codex whose sessions get polaris_desktop through the real DesktopMcp, on a Host whose
 * state the test turns: each open records the server it got.
 */
const setup = () => {
  let state: ComputerUseState = OFF;
  const ready = Effect.runSync(Deferred.make<void>());

  const desktop = Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        return yield* DesktopMcp;
      }),
      DesktopMcp.layerWith(
        fakeDeps(fakeRunner({}).runner, {
          host: fakeHost({
            state: Effect.sync(() => state),
            untilReady: Deferred.await(ready),
          }),
        })
      )
    )
  );

  const fake = makeFakeDriver("codex");
  const servers: Array<DesktopServer | null> = [];

  const driver: FakeDriver = {
    ...fake,
    driver: {
      ...fake.driver,
      open: (options) =>
        Effect.gen(function* () {
          servers.push(yield* desktop.forSession(options));

          return yield* fake.driver.open(options);
        }),
    },
  };

  const layer = engineLayer({
    filename: join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [driver],
  }).pipe(Layer.provide(Layer.succeed(DesktopMcp)(desktop)));

  /** The user turns computer use on and the Host turns Ready. */
  const turnOn = Effect.andThen(
    Effect.sync(() => void (state = READY)),
    Deferred.succeed(ready, undefined)
  );

  return { layer, fake, servers, turnOn };
};

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer)));

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "test" })
  );

const startWorking = (sessionId: SessionId, fake: FakeDriver) =>
  Effect.gen(function* () {
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: fakeRepo(), name: null }));
    const model = yield* waitFor((m) => m.workspaces.size > 0);
    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId,
        workspaceId: [...model.workspaces.values()][0]!.id,
        harness: "codex",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "Fill in the quarterly report in Numbers",
        attachments: [],
      })
    );
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working");
    yield* waitUntil(() => fake.latest(sessionId) !== undefined);
    fake.latest(sessionId)!.emit(HarnessEvent.CursorAssigned({ cursor: CURSOR }));
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.harnessCursor === CURSOR);
  });

/** The agent calls request_computer_use; resolves once the session Needs You for it. */
const agentAsks = (sessionId: SessionId, server: DesktopServer | null | undefined) =>
  Effect.gen(function* () {
    const tool = server?.tools.find((t) => t.name === "request_computer_use");
    expect(tool).toBeDefined();

    const call = yield* Effect.promise(
      () =>
        tool?.call({ app: "Numbers", reason: "To fill in the quarterly report" }) ??
        Promise.reject(new Error("no tool"))
    ).pipe(Effect.forkScoped);

    const model = yield* waitFor((m) => (m.sessions.get(sessionId)?.pending.size ?? 0) > 0);
    const record = model.sessions.get(sessionId)!;
    const request: ApprovalRequest = [...record.pending.values()][0]!;

    return { call, request, state: record.session.state };
  });

const textOf = (result: { readonly content: ReadonlyArray<{ readonly type: string }> }) =>
  result.content.map((c) => ("text" in c ? String(c.text) : "")).join("\n");

const endTurn = (sessionId: SessionId, fake: FakeDriver) =>
  Effect.gen(function* () {
    const model = yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working");
    const turnId = model.sessions.get(sessionId)!.turns.at(-1)!.id;
    fake
      .latest(sessionId)!
      .emit(HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");
  });

describe("a session asks for computer use while it's off", () => {
  test("it Needs You with the notice; turning computer use on clears it, and the next Turn resumes with polaris_desktop", async () => {
    const { layer, fake, servers, turnOn } = setup();
    const S = SessionId.make("cu-on");

    const seen = await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S, fake);
        const { call, request, state } = yield* agentAsks(S, servers[0]);

        yield* turnOn;

        const answer = textOf(yield* Fiber.join(call));

        const cleared = yield* waitFor(
          (m) => m.sessions.get(S)?.pending.size === 0,
          2000,
          "the request clears"
        );

        yield* endTurn(S, fake);
        const first = fake.latest(S)!;
        yield* waitUntil(() => first.closed, 2000, "the Harness stops after the Turn");

        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId: S, prompt: "Carry on", attachments: [] })
        );
        yield* waitUntil(() => servers.length === 2, 2000, "the next Turn reopens the Harness");

        return {
          request,
          state,
          answer,
          after: cleared.sessions.get(S)!.session.state,
          firstTools: servers[0]?.tools.map((t) => t.name),
          nextTools: servers[1]?.tools.map((t) => t.name) ?? [],
          resumed: fake.latest(S)!.options.resumeCursor,
          turns: fake.latest(S)!.turns.map((t) => t.prompt),
        };
      })
    );

    expect(seen.state).toBe("needs-you");
    expect(seen.request.kind).toBe("computer-use");
    expect(seen.request.computerUse).toMatchObject({
      state: OFF,
      app: "Numbers",
      reason: "To fill in the quarterly report",
    });
    expect(seen.firstTools).toEqual(["request_computer_use"]);
    expect(seen.answer).toContain("Computer use is on now");
    expect(seen.after).toBe("working");
    expect(seen.nextTools).toContain("snapshot");
    expect(seen.nextTools).not.toContain("request_computer_use");
    // The same conversation: the reopened Harness resumes the first one's thread.
    expect(seen.resumed).toBe(CURSOR);
    expect(seen.turns).toEqual(["Carry on"]);
  });

  test("Not now clears it, the agent carries on without, and the Harness keeps running", async () => {
    const { layer, fake, servers } = setup();
    const S = SessionId.make("cu-not-now");

    const seen = await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S, fake);
        const { call, request } = yield* agentAsks(S, servers[0]);

        const refused = yield* dispatch(
          Command.cases.RespondToApproval.make({
            sessionId: S,
            requestId: request.id,
            decision: ApprovalDecision.cases.Allow.make({ remember: false }),
          })
        ).pipe(Effect.flip);

        const stillPending = (yield* waitFor(() => true)).sessions.get(S)?.pending.size;

        yield* dispatch(
          Command.cases.RespondToApproval.make({
            sessionId: S,
            requestId: request.id,
            decision: ApprovalDecision.cases.Deny.make({ reason: null }),
          })
        );
        const answer = textOf(yield* Fiber.join(call));
        yield* endTurn(S, fake);

        return {
          refused,
          stillPending,
          answer,
          responses: fake.latest(S)!.responses.length,
          closed: fake.latest(S)!.closed,
        };
      })
    );

    expect(Predicate.isTagged(seen.refused, "CommandRejected")).toBe(true);
    expect(seen.stillPending).toBe(1);
    expect(seen.answer).toContain("The user said not now");
    // Polaris opened it, so the Harness is never asked to answer it.
    expect(seen.responses).toBe(0);
    expect(seen.closed).toBe(false);
  });

  test("a Client without computer-use is never sent the request", async () => {
    const { layer, fake, servers } = setup();
    const S = SessionId.make("cu-gated");

    const [older, newer] = await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S, fake);
        yield* agentAsks(S, servers[0]);
        const engine = yield* Engine;

        const pendingSeen = (capabilities: ReadonlyArray<"computer-use">) =>
          engine
            .subscribeSession({ sessionId: S, afterSequence: null, turnLimit: null, capabilities })
            .pipe(
              Stream.take(1),
              Stream.runHead,
              Effect.map((item) => {
                const head = Option.getOrNull(item);

                return Predicate.isTagged(head, "Snapshot") ? head.pendingApprovals.length : -1;
              })
            );

        return [yield* pendingSeen([]), yield* pendingSeen(["computer-use"])] as const;
      })
    );

    expect(older).toBe(0);
    expect(newer).toBe(1);
  });
});
