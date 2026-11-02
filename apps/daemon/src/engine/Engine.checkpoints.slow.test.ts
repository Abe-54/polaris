/**
 * Checkpoint pruning wired into the engine: `onSessionArchived` on Archive,
 * the periodic sweeper over every git Workspace, and dropping a removed
 * Workspace's checkpoints. The Harness is fake; the repositories are real,
 * with checkpoint refs created where the fake Checkpoints says it put them.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, SessionId, SessionPlacement, type Workspace } from "@polaris/protocol";
import { Duration, Effect, type Layer } from "effect";
import { gitText } from "../git/git.ts";
import { type CheckpointPolicy, listCheckpointRefs } from "../git/prune.ts";
import { makeRepo, removeDir } from "../git/testing.ts";
import type { EventStore } from "../store/EventStore.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
} from "./testing.ts";

type Env = Engine | EventStore;

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const sid = (s: string) => SessionId.make(s);

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "MacBook" })
  );

const DAY = 24 * 60 * 60 * 1000;

const setup = (options: {
  readonly policy: CheckpointPolicy;
  readonly sweepInterval?: Duration.Input;
  readonly fakes?: ReturnType<typeof makeFakes>;
}) => {
  const claude = makeFakeDriver("claude", { onTurn: completesTurns() });

  const base = {
    filename: join(tempDir(), "state.sqlite"),
    fakes: options.fakes ?? makeFakes(),
    drivers: [claude],
    checkpointPolicy: options.policy,
  };

  if (options.sweepInterval === undefined) return engineLayer(base);

  return engineLayer({ ...base, checkpointSweepInterval: options.sweepInterval });
};

const registerWorkspace = (repo: string) =>
  Effect.gen(function* () {
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
    const model = yield* waitFor((m) => [...m.workspaces.values()].some((w) => w.path === repo));

    return [...model.workspaces.values()].find((w) => w.path === repo)!;
  });

/** Start a session and run `turns` Turns to completion; returns their ids in order. */
const sessionWithTurns = (workspace: Workspace, sessionId: SessionId, turns: number) =>
  Effect.gen(function* () {
    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId,
        workspaceId: workspace.id,
        harness: "claude",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "turn 0",
        attachments: [],
      })
    );
    yield* waitFor((m) => m.sessions.get(sessionId)?.turns[0]?.status === "completed");

    for (let i = 1; i < turns; i++) {
      yield* dispatch(
        Command.cases.SendTurn.make({ sessionId, prompt: `turn ${i}`, attachments: [] })
      );
      yield* waitFor(
        (m) =>
          m.sessions.get(sessionId)?.turns.length === i + 1 &&
          m.sessions.get(sessionId)?.turns[i]?.status === "completed"
      );
    }

    const model = yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");

    return model.sessions.get(sessionId)!.turns.map((t) => t.id);
  });

/** Create the refs the fake Checkpoints reported, pointing at HEAD. */
const createRefs = (repo: string, sessionId: string, turnIds: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const updates = turnIds.flatMap((turnId) =>
      ["before", "after"].map(
        (label) => `update refs/polaris/checkpoints/${sessionId}/${turnId}/${label} HEAD`
      )
    );

    // Prepare every lock before refs become visible; "host" lets the test's hook watch.
    await gitText(repo, ["update-ref", "--stdin"], {
      config: "host",
      stdin: `start\n${updates.join("\n")}\nprepare\ncommit\n`,
    });
  });

const refsOf = (repo: string, sessionId: string) =>
  Effect.promise(async () =>
    (await listCheckpointRefs(repo))
      .filter((r) => r.sessionId === sessionId)
      .map((r) => `${r.turnId}/${r.label}`)
      .sort()
  );

const archive = (sessionId: SessionId) =>
  Effect.gen(function* () {
    yield* dispatch(Command.cases.ArchiveSession.make({ sessionId, deleteMergedBranch: false }));
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "archived");
  });

describe("checkpoint pruning", () => {
  test("fixture prepares every ref before publishing a session to the sweeper", async () => {
    const repo = await makeRepo();
    const observations = join(repo, ".git", "checkpoint-seed-observations");
    const hook = join(repo, ".git", "hooks", "reference-transaction");

    try {
      writeFileSync(
        hook,
        `#!/bin/sh
if [ "$1" = prepared ]; then
  pending=0
  while read -r old new ref; do pending=$((pending + 1)); done
  visible=0
  for ref in $(git for-each-ref --format='%(refname)' refs/polaris/checkpoints/s-seed); do
    visible=$((visible + 1))
  done
  echo "$pending $visible" >> .git/checkpoint-seed-observations
fi
`
      );
      chmodSync(hook, 0o755);
      await gitText(repo, ["config", "core.hooksPath", ".git/hooks"]);
      await Effect.runPromise(createRefs(repo, "s-seed", ["turn-a", "turn-b"]));

      expect(readFileSync(observations, "utf8")).toBe("4 0\n");
      expect(await Effect.runPromise(refsOf(repo, "s-seed"))).toEqual([
        "turn-a/after",
        "turn-a/before",
        "turn-b/after",
        "turn-b/before",
      ]);
    } finally {
      removeDir(repo);
    }
  });

  test("Archive compacts the session per the policy, keeping Turns a Fork started from", async () => {
    const repo = await makeRepo();
    const layer = setup({ policy: { compactAfterMs: 0, dropAfterMs: 30 * DAY } });

    try {
      await run(
        layer,
        Effect.gen(function* () {
          const workspace = yield* registerWorkspace(repo);
          const parent = sid("s-ck-parent");
          const other = sid("s-ck-other");
          const turns = yield* sessionWithTurns(workspace, parent, 4);
          const otherTurns = yield* sessionWithTurns(workspace, other, 2);
          yield* createRefs(repo, parent, turns);
          yield* createRefs(repo, other, otherTurns);
          yield* dispatch(
            Command.cases.ForkSession.make({
              sessionId: sid("s-ck-fork"),
              fromSessionId: parent,
              fromTurnId: turns[1]!,
              harness: "claude",
              model: null,
              effort: null,
            })
          );
          yield* waitFor((m) => m.sessions.has(sid("s-ck-fork")));

          yield* archive(parent);

          const expected = [
            `${turns[0]}/before`,
            `${turns[1]}/after`,
            `${turns[1]}/before`,
            `${turns[3]}/after`,
          ].sort();

          const deadline = Date.now() + 3000;
          let kept = yield* refsOf(repo, parent);

          while (kept.length !== expected.length && Date.now() < deadline) {
            yield* Effect.sleep(Duration.millis(20));
            kept = yield* refsOf(repo, parent);
          }

          expect(kept).toEqual(expected);
          // Another session's checkpoints are untouched.
          expect(yield* refsOf(repo, other)).toHaveLength(4);
        })
      );
    } finally {
      removeDir(repo);
    }
  });

  test("the sweeper drops old Archived sessions and keeps live and unknown ones", async () => {
    const repo = await makeRepo();

    const fakes = makeFakes();

    const layer = setup({
      fakes,
      policy: { compactAfterMs: 0, dropAfterMs: 0 },
      sweepInterval: Duration.millis(50),
    });

    try {
      await run(
        layer,
        Effect.gen(function* () {
          const workspace = yield* registerWorkspace(repo);
          const gone = sid("s-sw-gone");
          const live = sid("s-sw-live");
          const goneTurns = yield* sessionWithTurns(workspace, gone, 2);
          const liveTurns = yield* sessionWithTurns(workspace, live, 2);
          yield* archive(gone);
          // Refs that appear after Archive (so only the sweeper can remove them).
          yield* waitFor(() => fakes.archived.includes(gone));
          yield* createRefs(repo, gone, goneTurns);
          yield* createRefs(repo, live, liveTurns);
          yield* createRefs(repo, "s-sw-unknown", ["turn-x"]);
          const deadline = Date.now() + 3000;

          while ((yield* refsOf(repo, gone)).length > 0 && Date.now() < deadline) {
            yield* Effect.sleep(Duration.millis(20));
          }

          expect(yield* refsOf(repo, gone)).toEqual([]);
          expect(yield* refsOf(repo, live)).toHaveLength(4);
          expect(yield* refsOf(repo, "s-sw-unknown")).toHaveLength(2);
        })
      );
    } finally {
      removeDir(repo);
    }
  });

  test("removing a Workspace drops its sessions' checkpoints", async () => {
    const repo = await makeRepo();
    // The default policy keeps everything of a session Archived just now.
    const layer = setup({ policy: { compactAfterMs: 7 * DAY, dropAfterMs: 30 * DAY } });

    try {
      await run(
        layer,
        Effect.gen(function* () {
          const workspace = yield* registerWorkspace(repo);
          const s = sid("s-rm");
          const turns = yield* sessionWithTurns(workspace, s, 2);
          yield* createRefs(repo, s, turns);
          yield* createRefs(repo, "s-rm-unknown", ["turn-y"]);
          yield* archive(s);
          expect(yield* refsOf(repo, s)).toHaveLength(4);

          yield* dispatch(Command.cases.RemoveWorkspace.make({ workspaceId: workspace.id }));
          yield* waitFor((m) => !m.workspaces.has(workspace.id));
          const deadline = Date.now() + 3000;

          while ((yield* refsOf(repo, s)).length > 0 && Date.now() < deadline) {
            yield* Effect.sleep(Duration.millis(20));
          }

          expect(yield* refsOf(repo, s)).toEqual([]);
          expect(yield* refsOf(repo, "s-rm-unknown")).toHaveLength(2);
        })
      );
    } finally {
      removeDir(repo);
    }
  });
});
