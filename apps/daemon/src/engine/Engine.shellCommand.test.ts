import { expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Command,
  type HarnessKind,
  SessionId,
  SessionPlacement,
  type TurnId,
} from "@polaris/protocol";
import { Effect, type Layer, Predicate } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  fakeRepo,
  type FakeDriver,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "./testing.ts";

type Env = Engine | EventStore;

const windows = process.platform === "win32";

/**
 * How long a real shell command may take to run, Git Bash's cold login start on a Windows runner
 * included (over 2 s under load); the Engine's own steps keep waitFor's default.
 */
const SHELL_RUN_MS = 10_000;

/** Git Bash's `pwd` prints an MSYS path (`/tmp/…`); `-W` prints the directory as Windows has it. */
const PWD = windows ? "pwd -W" : "pwd";

const printedDir = (dir: string) =>
  windows ? realpathSync(dir).replaceAll("\\", "/") : realpathSync(dir);

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "test" })
  );

const layerFor = (driver: FakeDriver) =>
  engineLayer({ filename: join(tempDir(), "state.sqlite"), fakes: makeFakes(), drivers: [driver] });

/** A session on `harness`, once its first Turn reaches `state`. */
const startSession = (
  harness: HarnessKind,
  sessionId: SessionId,
  state: "idle" | "working" = "idle"
) =>
  Effect.gen(function* () {
    const cwd = fakeRepo();
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: cwd, name: null }));
    const registered = yield* waitFor((m) => m.workspaces.size > 0, undefined, "workspace");
    const workspace = [...registered.workspaces.values()][0]!;

    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId,
        workspaceId: workspace.id,
        harness,
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "go",
        attachments: [],
      })
    );
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === state, undefined, state);

    return cwd;
  });

const itemsOf = (turnId: TurnId) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const { sequence } = yield* store.model;
    const items = yield* store.readTurnItems({ turnIds: [turnId], upTo: sequence });

    return items.get(turnId) ?? [];
  });

test("a shell command runs in the session's directory, then the Harness reads its output and replies", async () => {
  const driver = makeFakeDriver("claude", { shellCommand: true, onTurn: completesTurns() });
  const sessionId = SessionId.make("s-shell");

  await run(
    layerFor(driver),
    Effect.gen(function* () {
      const cwd = yield* startSession("claude", sessionId);
      const command = `${PWD}; echo oops >&2; exit 3`;

      yield* dispatch(Command.cases.RunShellCommand.make({ sessionId, command: `  ${command} ` }));

      const model = yield* waitFor(
        (m) =>
          m.sessions.get(sessionId)?.session.state === "idle" &&
          m.sessions.get(sessionId)?.turns.length === 2,
        SHELL_RUN_MS,
        "the shell command's Turn"
      );

      const turn = model.sessions.get(sessionId)!.turns[1]!;

      expect(turn).toMatchObject({
        prompt: `! ${command}`,
        shellCommand: command,
        status: "completed",
      });
      // The Harness got the command's output, not the prompt as text.
      expect(driver.latest(sessionId)!.turns.at(-1)!.shellCommand).toEqual({
        command,
        stdout: `${printedDir(cwd)}\n`,
        stderr: "oops\n",
        exitCode: 3,
        failure: null,
      });

      const items = yield* itemsOf(turn.id);
      const shell = items.find((i) => Predicate.isTagged(i, "CommandExecution"));

      expect(shell).toMatchObject({
        command,
        cwd,
        exitCode: 3,
        status: "failed",
        origin: "user",
      });
      expect(shell?._tag === "CommandExecution" && shell.output).toContain("oops");
      // The command item comes first, then the agent's reply.
      expect(items.map((i) => i._tag)).toEqual(["CommandExecution", "AssistantMessage"]);
    })
  );
});

test("Interrupt stops a running shell command and the Turn ends Interrupted without reaching the Harness", async () => {
  const driver = makeFakeDriver("claude", { shellCommand: true, onTurn: completesTurns() });
  const sessionId = SessionId.make("s-shell-interrupt");

  await run(
    layerFor(driver),
    Effect.gen(function* () {
      const cwd = yield* startSession("claude", sessionId);
      const turnsBefore = driver.latest(sessionId)!.turns.length;

      yield* dispatch(
        Command.cases.RunShellCommand.make({ sessionId, command: "touch started; sleep 30" })
      );
      yield* waitUntil(() => existsSync(join(cwd, "started")), SHELL_RUN_MS, "the shell started");
      yield* dispatch(Command.cases.Interrupt.make({ sessionId }));

      const model = yield* waitFor(
        (m) =>
          m.sessions.get(sessionId)?.turns[1]?.status === "interrupted" &&
          m.sessions.get(sessionId)?.session.state === "idle",
        SHELL_RUN_MS,
        "the interrupted Turn"
      );

      expect(driver.latest(sessionId)!.turns.length).toBe(turnsBefore);
      const items = yield* itemsOf(model.sessions.get(sessionId)!.turns[1]!.id);

      expect(items.map((item) => item._tag)).toEqual(["CommandExecution"]);
      expect(items[0]).toMatchObject({ status: "failed", exitCode: null });
    })
  );
});

test("a steer sent while the shell command runs reaches the Harness after the command's output", async () => {
  const driver = makeFakeDriver("claude", {
    shellCommand: true,
    steer: true,
    onTurn: completesTurns(),
  });

  const sessionId = SessionId.make("s-shell-steer");

  await run(
    layerFor(driver),
    Effect.gen(function* () {
      const cwd = yield* startSession("claude", sessionId);
      const command = "touch started; while [ ! -e go ]; do sleep 0.02; done";

      yield* dispatch(Command.cases.RunShellCommand.make({ sessionId, command }));
      yield* waitUntil(() => existsSync(join(cwd, "started")), SHELL_RUN_MS, "the shell started");
      yield* dispatch(Command.cases.Steer.make({ sessionId, text: "and summarize it" }));
      yield* Effect.sleep(100);
      const harness = driver.latest(sessionId)!;

      expect(harness.steers).toEqual([]);
      writeFileSync(join(cwd, "go"), "");
      yield* waitUntil(() => harness.steers.length === 1, SHELL_RUN_MS, "the steer");

      expect(harness.turns.at(-1)!.shellCommand?.command).toBe(command);
      expect(harness.steers).toEqual(["and summarize it"]);
    })
  );
});

test("a shell command is refused for a Harness that can't read one, and while a Turn works", async () => {
  const refusal = (driver: FakeDriver, harness: HarnessKind, state: "idle" | "working") =>
    run(
      layerFor(driver),
      Effect.gen(function* () {
        const sessionId = SessionId.make(`s-refused-${harness}`);
        yield* startSession(harness, sessionId, state);

        const rejected = yield* Effect.flip(
          dispatch(Command.cases.RunShellCommand.make({ sessionId, command: "ls" }))
        );

        return Predicate.isTagged(rejected, "CommandRejected") ? rejected.reason : rejected._tag;
      })
    );

  const codex = makeFakeDriver("codex", { onTurn: completesTurns() });
  // No scripted reply: its first Turn stays in flight.
  const claude = makeFakeDriver("claude", { shellCommand: true });

  expect(await refusal(codex, "codex", "idle")).toBe("codex can't run shell commands");
  expect(await refusal(claude, "claude", "working")).toBe(
    "the session is working; wait for the Turn to end"
  );
});
