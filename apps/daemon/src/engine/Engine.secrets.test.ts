import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ApprovalDecision,
  Command,
  type RequestId,
  SessionId,
  SessionPlacement,
  TurnItem,
} from "@polaris/protocol";
import { Effect, Fiber, type Layer, Option, Predicate, Redacted, type Scope, Stream } from "effect";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { EventStore } from "../store/EventStore.ts";
import { Engine, SecretOutcome } from "./Engine.ts";
import {
  cid,
  engineLayer,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "./testing.ts";

type Env = Engine | EventStore;

const VALUE = "tskey-auth-k3y-never-logged";

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "test" })
  );

const setup = () => {
  const driver = makeFakeDriver("codex");
  const filename = join(tempDir(), "state.sqlite");

  return {
    driver,
    filename,
    layer: engineLayer({ filename, fakes: makeFakes(), drivers: [driver] }),
  };
};

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer)));

const startWorking = (sessionId: SessionId) =>
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
        prompt: "go",
        attachments: [],
      })
    );
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working");
  });

/** Starts a Secret Request in the background; resolves with its id once it is pending. */
const ask = (sessionId: SessionId, timeoutMs = 60_000) =>
  Effect.gen(function* () {
    const engine = yield* Engine;

    const fiber = yield* engine
      .requestSecret(sessionId, {
        label: "Tailscale key",
        reason: "For test VMs",
        placeholder: null,
        timeoutMs,
      })
      .pipe(Effect.forkScoped);

    const model = yield* waitFor((m) => (m.sessions.get(sessionId)?.pending.size ?? 0) > 0);
    const request = [...model.sessions.get(sessionId)!.pending.values()][0]!;

    return { fiber, requestId: request.id, request };
  });

const respond = (sessionId: SessionId, requestId: RequestId, decision: ApprovalDecision) =>
  dispatch(Command.cases.RespondToApproval.make({ sessionId, requestId, decision }));

/** Every event payload the Host wrote to its log, as stored. */
const loggedPayloads = (filename: string) => {
  const db = new Database(filename, { readonly: true });

  try {
    return db
      .query<{ payload: string }, []>("SELECT payload FROM events")
      .all()
      .map((row) => row.payload)
      .join("\n");
  } finally {
    db.close();
  }
};

describe("Secret Requests", () => {
  test("a provided secret lands in a file the agent is told about, and never in the log", async () => {
    const { layer, filename } = setup();
    const S = SessionId.make("secret-saved");

    const outcome = await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S);
        const { fiber, requestId, request } = yield* ask(S);
        expect(request.kind).toBe("secret");
        expect((yield* waitFor(() => true)).sessions.get(S)?.session.state).toBe("needs-you");

        yield* (yield* Engine).provideSecret(S, requestId, Redacted.make(VALUE), "Mac");

        return yield* Fiber.join(fiber);
      })
    );

    const file = Predicate.isTagged(outcome, "Saved") ? outcome.file : "";
    expect(readFileSync(file, "utf8")).toBe(VALUE);
    expect(loggedPayloads(filename)).not.toContain(VALUE);
  });

  test("a decline tells the agent", async () => {
    const { layer } = setup();
    const S = SessionId.make("secret-declined");

    const outcome = await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S);
        const { fiber, requestId } = yield* ask(S);
        yield* respond(S, requestId, ApprovalDecision.cases.Deny.make({ reason: null }));

        return yield* Fiber.join(fiber);
      })
    );

    expect(outcome).toEqual(SecretOutcome.Declined());
  });

  test("an unanswered request times out, is withdrawn, and the session goes back to work", async () => {
    const { layer } = setup();
    const S = SessionId.make("secret-timeout");

    const [outcome, state, late] = await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S);
        const { fiber, requestId } = yield* ask(S, 50);
        const outcome = yield* Fiber.join(fiber);
        const model = yield* waitFor(() => true);

        const late = yield* (yield* Engine)
          .provideSecret(S, requestId, Redacted.make(VALUE), "Mac")
          .pipe(Effect.flip);

        return [outcome, model.sessions.get(S)?.session.state, late] as const;
      })
    );

    expect(outcome).toEqual(SecretOutcome.TimedOut());
    expect(state).toBe("working");
    expect(Predicate.isTagged(late, "SecretRejected") && late.reason).toBe("ended");
  });

  test("a Client can't answer a Secret Request with Allow, or claim Provided without a value", async () => {
    const { layer } = setup();
    const S = SessionId.make("secret-refused");

    const [allow, provided, stillPending] = await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S);
        const { requestId } = yield* ask(S);

        const allow = yield* respond(
          S,
          requestId,
          ApprovalDecision.cases.Allow.make({ remember: false })
        ).pipe(Effect.flip);

        const provided = yield* respond(
          S,
          requestId,
          ApprovalDecision.cases.Provided.make({})
        ).pipe(Effect.flip);

        const model = yield* waitFor(() => true);

        return [allow, provided, model.sessions.get(S)?.pending.has(requestId)] as const;
      })
    );

    expect(Predicate.isTagged(allow, "CommandRejected")).toBe(true);
    expect(Predicate.isTagged(provided, "CommandRejected")).toBe(true);
    expect(stillPending).toBe(true);
  });

  test("the Harness never hears of a Secret Request's answer", async () => {
    const { layer, driver } = setup();
    const S = SessionId.make("secret-harness");

    await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S);
        const { fiber, requestId } = yield* ask(S);
        yield* respond(S, requestId, ApprovalDecision.cases.Deny.make({ reason: null }));
        yield* Fiber.join(fiber);
      })
    );

    expect(driver.latest(S)?.responses).toEqual([]);
  });

  test("a live secret a command prints is redacted before it is recorded", async () => {
    const { layer, driver, filename } = setup();
    const S = SessionId.make("secret-redacted");

    await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S);
        const { fiber, requestId } = yield* ask(S);
        yield* (yield* Engine).provideSecret(S, requestId, Redacted.make(VALUE), "Mac");
        yield* Fiber.join(fiber);
        const harness = driver.latest(S)!;

        harness.emit(
          HarnessEvent.ItemCompleted({
            turnId: harness.turns[0]!.turnId,
            item: TurnItem.cases.CommandExecution.make({
              id: "cmd-1",
              startedAt: null,
              command: "cat key",
              cwd: "/",
              output: `${VALUE}\n`,
              exitCode: 0,
              status: "completed",
            }),
          })
        );
        yield* waitUntil(() => loggedPayloads(filename).includes("cmd-1"));
      })
    );

    const logged = loggedPayloads(filename);
    expect(logged).toContain('"output":"[secret]\\n"');
    expect(logged).not.toContain(VALUE);
  });

  test("a Client without approval.secret is never sent a Secret Request", async () => {
    const { layer } = setup();
    const S = SessionId.make("secret-gated");

    const [older, newer] = await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S);
        yield* ask(S);
        const engine = yield* Engine;

        const snapshot = (capabilities: ReadonlyArray<"approval.secret">) =>
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

        return [yield* snapshot([]), yield* snapshot(["approval.secret"])] as const;
      })
    );

    expect(older).toBe(0);
    expect(newer).toBe(1);
  });

  test("archiving the session deletes its secrets", async () => {
    const { layer, driver } = setup();
    const S = SessionId.make("secret-archived");

    const file = await run(
      layer,
      Effect.gen(function* () {
        yield* startWorking(S);
        const { fiber, requestId } = yield* ask(S);
        yield* (yield* Engine).provideSecret(S, requestId, Redacted.make(VALUE), "Mac");
        const outcome = yield* Fiber.join(fiber);
        const harness = driver.latest(S)!;
        harness.emit(
          HarnessEvent.TurnEnded({
            turnId: harness.turns[0]!.turnId,
            status: "completed",
            error: null,
          })
        );
        yield* waitFor((m) => m.sessions.get(S)?.session.state === "idle");
        yield* dispatch(
          Command.cases.ArchiveSession.make({ sessionId: S, deleteMergedBranch: false })
        );
        const file = Predicate.isTagged(outcome, "Saved") ? outcome.file : "";
        expect(existsSync(file)).toBe(true);
        // The archive reactor runs after the commit.
        yield* waitUntil(() => !existsSync(file));

        return file;
      })
    );

    expect(existsSync(file)).toBe(false);
  });
});
