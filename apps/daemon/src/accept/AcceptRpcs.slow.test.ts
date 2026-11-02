/**
 * Accepting end to end on a real repository: a fake Harness edits files in
 * its Turns, real checkpoints are captured, then `AcceptTurns` (with and
 * without reverting) and the accept RPCs plan, draft, commit and push.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AcceptBranch,
  AcceptRefused,
  Command,
  CommandRejected,
  SessionId,
  SessionPlacement,
  TurnItem,
  type TurnId,
} from "@polaris/protocol";
import { Effect, Layer, Predicate } from "effect";
import { RpcTest } from "effect/rpc";
import { Engine } from "../engine/Engine.ts";
import {
  cid,
  engineLayer,
  type FakeDriver,
  makeFakeDriver,
  makeFakes,
  tempDir as engineDir,
  waitFor,
} from "../engine/testing.ts";
import { CheckpointsLive } from "../git/Checkpoints.ts";
import { gitText } from "../git/git.ts";
import { makeRepo, removeDir, tempDir, write } from "../git/testing.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { HarnessRegistry } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import type { ReadModel } from "../store/model.ts";
import { AcceptRpcs, AcceptRpcsLive } from "./AcceptRpcs.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const DRAFT = JSON.stringify({
  title: "Add the greeting and the farewell",
  body: "Both files are new.",
  prTitle: "Greeting and farewell",
  prBody: "Adds two files.",
  turnTitles: ["Add the greeting", "Add the farewell"],
});

/** Each Turn writes `<name>.txt` for a prompt `<name>[:<content>]`; the draft Turn answers JSON. */
const harness = (repo: string): FakeDriver =>
  makeFakeDriver("claude", {
    onTurn: (input) => {
      const drafting = input.turnId.endsWith("accept-draft-turn");

      const [name, content = name] = input.prompt.split(":");

      if (!drafting) write(repo, `${name}.txt`, `${content}\n`);

      return [
        HarnessEvent.TurnStarted({ turnId: input.turnId, prompt: input.prompt }),
        HarnessEvent.ItemCompleted({
          turnId: input.turnId,
          item: TurnItem.cases.AssistantMessage.make({
            id: `m-${input.turnId}`,
            text: drafting ? `Here it is:\n${DRAFT}` : `wrote ${input.prompt}`,
          }),
        }),
        HarnessEvent.TurnEnded({ turnId: input.turnId, status: "completed", error: null }),
      ];
    },
  });

const setup = (repo: string) => {
  const claude = harness(repo);

  const engine = engineLayer({
    filename: join(engineDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [claude],
    checkpoints: CheckpointsLive,
  });

  const registry = Layer.succeed(HarnessRegistry)({
    get: () => Effect.succeed(claude.driver),
    all: Effect.succeed([claude.driver]),
  });

  return Layer.merge(engine, AcceptRpcsLive.pipe(Layer.provide(engine), Layer.provide(registry)));
};

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "MacBook" })
  );

const sessionId = SessionId.make("s-accept");

/** Registers `repo` (once), then runs one Turn per prompt in session `id`; answers the Turn ids. */
const runTurns = (repo: string, prompts: ReadonlyArray<string>, id = sessionId) =>
  Effect.gen(function* () {
    const registered = (m: ReadModel) => [...m.workspaces.values()].some((w) => w.path === repo);

    if (!registered(yield* Effect.flatMap(EventStore, (store) => store.model))) {
      yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
    }

    const model = yield* waitFor(registered);
    const workspace = [...model.workspaces.values()].find((w) => w.path === repo)!;

    for (const [i, prompt] of prompts.entries()) {
      yield* dispatch(
        i === 0
          ? Command.cases.StartSession.make({
              sessionId: id,
              workspaceId: workspace.id,
              harness: "claude",
              placement: SessionPlacement.cases.InPlace.make({}),
              permissionMode: "supervised",
              model: null,
              effort: null,
              prompt,
              attachments: [],
            })
          : Command.cases.SendTurn.make({ sessionId: id, prompt, attachments: [] })
      );
      yield* waitFor((m) => {
        const turn = m.sessions.get(id)?.turns[i];

        return turn?.status === "completed" && turn.checkpointAfter !== null;
      }, 5000);
    }

    const done = yield* waitFor((m) => m.sessions.get(id)?.session.state === "idle");

    return done.sessions.get(id)!.turns.map((t) => t.id);
  });

const accept = (throughTurnId: TurnId, revertLaterTurns: boolean) =>
  Effect.gen(function* () {
    yield* dispatch(Command.cases.AcceptTurns.make({ sessionId, throughTurnId, revertLaterTurns }));
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.acceptedThroughIndex !== null);
  });

const withRepo = async () => {
  const repo = await makeRepo();
  const remote = tempDir("polaris-remote-");
  cleanup.push(repo, remote);
  await gitText(remote, ["init", "-q", "--bare", "-b", "main"]);
  await gitText(repo, ["remote", "add", "origin", remote]);
  await gitText(repo, ["push", "-q", "origin", "main"]);
  await gitText(repo, ["remote", "set-head", "origin", "main"]);

  return { repo, remote };
};

describe("accepting an Agent Session's work", () => {
  test("plan, draft, commit on a new branch, push", async () => {
    const { repo, remote } = await withRepo();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const turns = yield* runTurns(repo, ["hello", "bye", "later"]);
          const client = yield* RpcTest.makeClient(AcceptRpcs);
          const through = turns[1]!;

          const refused = yield* client["session.commitAccepted"]({
            sessionId,
            throughTurnId: through,
            branch: AcceptBranch.cases.Current.make({}),
            granularity: "single",
            title: "x",
            body: "",
            turnTitles: [],
          }).pipe(Effect.flip);

          expect(refused).toEqual(
            new AcceptRefused({ reason: "accept the Turns through Turn 2 first" })
          );

          yield* accept(through, false);
          const plan = yield* client["session.acceptPlan"]({ sessionId, throughTurnId: through });
          expect(plan.turns.map((t) => t.title)).toEqual(["hello", "bye"]);
          expect(plan).toMatchObject({
            laterTurns: 1,
            branch: "main",
            defaultBranch: "main",
            worktree: false,
            files: 2,
            additions: 2,
            deletions: 0,
          });
          expect(plan.remote?.name).toBe("origin");

          // Null: through the latest Turn, so the later one is in the plan too.
          const latest = yield* client["session.acceptPlan"]({ sessionId, throughTurnId: null });
          expect(latest).toMatchObject({ laterTurns: 0 });
          expect(latest.turns).toHaveLength(plan.turns.length + 1);

          const draft = yield* client["session.draftAccept"]({ sessionId, throughTurnId: through });
          expect(draft).toMatchObject({
            source: "harness",
            title: "Add the greeting and the farewell",
            turnTitles: ["Add the greeting", "Add the farewell"],
          });

          const committed = yield* client["session.commitAccepted"]({
            sessionId,
            throughTurnId: through,
            branch: AcceptBranch.cases.Create.make({ name: "polaris/greetings" }),
            granularity: "per-turn",
            title: draft.title,
            body: draft.body,
            turnTitles: draft.turnTitles,
          });

          expect(committed).toMatchObject({ branch: "polaris/greetings", base: "main" });
          expect(committed.commits).toHaveLength(2);
          expect(
            yield* Effect.promise(() => gitText(repo, ["log", "--format=%s", "-n", "3"]))
          ).toBe("Add the farewell\nAdd the greeting\ninitial");
          // Turn 3's file is still there, uncommitted.
          expect(yield* Effect.promise(() => gitText(repo, ["status", "--porcelain"]))).toBe(
            "?? later.txt"
          );

          const again = yield* client["session.acceptPlan"]({ sessionId, throughTurnId: through });
          expect(again.turns).toEqual([]);

          const pushed = yield* client["session.pushAccepted"]({
            sessionId,
            branch: "polaris/greetings",
          });

          expect(pushed.remote.url).toBe(remote);
          expect(
            yield* Effect.promise(() => gitText(remote, ["rev-parse", "polaris/greetings"]))
          ).toBe(committed.commits[1]!);
        }).pipe(Effect.provide(setup(repo)))
      )
    );
  }, 30_000);

  test("accepting through an earlier Turn can revert the later ones", async () => {
    const { repo } = await withRepo();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const turns = yield* runTurns(repo, ["keep", "drop"]);
          yield* accept(turns[0]!, true);
          yield* Effect.promise(async () => {
            for (let i = 0; i < 100 && (await Bun.file(join(repo, "drop.txt")).exists()); i++) {
              await Bun.sleep(20);
            }
          });

          expect(yield* Effect.promise(() => Bun.file(join(repo, "drop.txt")).exists())).toBe(
            false
          );
          expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("keep\n");
        }).pipe(Effect.provide(setup(repo)))
      )
    );
  }, 30_000);

  test("a revert that would restore another session's files in the same directory is refused", async () => {
    const { repo } = await withRepo();
    const other = SessionId.make("s-other");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const turns = yield* runTurns(repo, ["keep", "shared:mine"]);
          yield* runTurns(repo, ["shared:theirs"], other);

          const refused = yield* dispatch(
            Command.cases.AcceptTurns.make({
              sessionId,
              throughTurnId: turns[0]!,
              revertLaterTurns: true,
            })
          ).pipe(Effect.flip);

          expect(refused).toBeInstanceOf(CommandRejected);
          expect(
            String(Predicate.isTagged(refused, "CommandRejected") && refused.reason)
          ).toContain(
            "another Agent Session in this checkout changed files the revert would restore"
          );
          expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("theirs\n");
          const model = yield* Effect.flatMap(EventStore, (store) => store.model);
          expect(model.sessions.get(sessionId)?.session.acceptedThroughIndex ?? null).toBeNull();
        }).pipe(Effect.provide(setup(repo)))
      )
    );
  }, 30_000);

  test("another session in the same directory with disjoint files doesn't stop a revert", async () => {
    const { repo } = await withRepo();
    const other = SessionId.make("s-other");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const turns = yield* runTurns(repo, ["keep", "drop"]);
          yield* runTurns(repo, ["theirs"], other);
          yield* accept(turns[0]!, true);
          yield* Effect.promise(async () => {
            for (let i = 0; i < 100 && (await Bun.file(join(repo, "drop.txt")).exists()); i++) {
              await Bun.sleep(20);
            }
          });

          expect(yield* Effect.promise(() => Bun.file(join(repo, "drop.txt")).exists())).toBe(
            false
          );
          expect(readFileSync(join(repo, "theirs.txt"), "utf8")).toBe("theirs\n");
        }).pipe(Effect.provide(setup(repo)))
      )
    );
  }, 30_000);

  test("archiving the session drops its committed-Turn marks", async () => {
    const { repo } = await withRepo();
    const marks = () => gitText(repo, ["for-each-ref", "refs/polaris/committed/"]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const turns = yield* runTurns(repo, ["one"]);
          const client = yield* RpcTest.makeClient(AcceptRpcs);

          yield* accept(turns[0]!, false);
          yield* client["session.commitAccepted"]({
            sessionId,
            throughTurnId: turns[0]!,
            branch: AcceptBranch.cases.Current.make({}),
            granularity: "single",
            title: "One",
            body: "",
            turnTitles: [],
          });
          expect(yield* Effect.promise(marks)).not.toBe("");

          yield* dispatch(
            Command.cases.ArchiveSession.make({ sessionId, deleteMergedBranch: false })
          );
          yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "archived");
          yield* Effect.promise(async () => {
            for (let i = 0; i < 100 && (await marks()) !== ""; i++) await Bun.sleep(20);
          });
          expect(yield* Effect.promise(marks)).toBe("");
        }).pipe(Effect.provide(setup(repo)))
      )
    );
  }, 30_000);
});
