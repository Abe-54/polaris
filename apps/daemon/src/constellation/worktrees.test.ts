import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Attempt, Constellation, WorktreeRequest } from "@polaris/protocol";
import { Effect, Struct } from "effect";
import { makeRepo, removeTempDir, write, commitAll } from "../git/testing.ts";
import { gitText } from "../git/git.ts";
import { ConstellationWorktrees } from "./worktrees.ts";
import { TransferStorage } from "./transfers/storage.ts";
import {
  CID,
  task,
  draft,
  HOST,
  LEAD,
  WS,
  AT,
  A,
  report,
} from "../engine/constellation.testing.ts";
import { ConstellationSettings } from "@polaris/protocol";
import { Layer } from "effect";

const graph = (attempt: Attempt) =>
  Constellation.make({
    id: CID,
    hostId: HOST,
    leadSessionId: LEAD,
    workspaceId: WS,
    name: "test",
    state: "archived",
    revision: 1,
    settings: ConstellationSettings.make({}),
    tasks: [],
    attempts: [attempt],
    pendingNotifications: [],
    createdAt: AT,
    updatedAt: AT,
  });

const run = <T, E>(program: Effect.Effect<T, E, ConstellationWorktrees>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        ConstellationWorktrees.layer.pipe(Layer.provide(TransferStorage.layer(":memory:")))
      )
    )
  );

/** Each test runs 60-90 real gits, about a second here but near bun's 5 s default on a busy runner. */
const GIT_WORK_MS = 15_000;

test(
  "Dispatch defaults, stable retries, send-back retention, real Claim/merge checks and safe cleanup",
  async () => {
    const root = await makeRepo();
    let path = "";

    try {
      await run(
        Effect.gen(function* () {
          const trees = yield* ConstellationWorktrees;

          const request = WorktreeRequest.make({
            key: "dispatch:A",
            constellationId: CID,
            task: task(),
            repoPath: root,
            leadPath: root,
            branchPrefix: "polaris",
            base: null,
            worktree: null,
            branch: null,
          });

          const prepared = yield* trees.prepare(request);
          path = prepared.worktree;
          expect(path).toBe(`${root}.worktrees/c1/A`);
          expect(prepared.branch).toBe("polaris/c1/A-a");
          expect(yield* trees.prepare(request)).toEqual(prepared);

          const attempt = Attempt.make(
            Struct.assign(draft(), {
              worktree: path,
              branch: prepared.branch,
              base: prepared.base,
            })
          );

          yield* Effect.promise(async () => {
            write(path, "work", "claimed");
          });
          expect((yield* trees.probeClaim(attempt)).dirtyPaths).toEqual(["work"]);
          const head = yield* Effect.promise(() => commitAll(path, "worker"));

          const review = Attempt.make(
            Struct.assign(attempt, {
              state: "review" as const,
              claim: report(prepared.branch, head),
            })
          );

          expect((yield* trees.probeClaim(review)).head).toBe(head);
          expect(yield* trees.mergeClaim(graph(review), review, root, head)).toEqual({
            merged: true,
            leadHead: head,
          });
          expect(yield* trees.mergeClaim(graph(review), review, root, head)).toEqual({
            merged: false,
            leadHead: head,
          });

          const sentBack = yield* trees.prepare(
            WorktreeRequest.make(Struct.assign(request, { key: "sendback:A" }))
          );

          expect(sentBack.managed).toBe(true);
          expect(sentBack.worktree).toBe(path);

          const accepted = Attempt.make(
            Struct.assign(review, { state: "accepted" as const, mergedHead: head })
          );

          expect(
            (yield* trees.cleanup(
              graph(accepted),
              root,
              [{ attempt: accepted, prepared }],
              new Set([accepted.sessionId])
            ))[0]?.removed
          ).toBe(false);

          const running = Constellation.make(
            Struct.assign(graph(accepted), { state: "running" as const })
          );

          expect(
            (yield* trees.cleanup(running, root, [{ attempt: accepted, prepared }], new Set()))[0]
              ?.reason
          ).toContain("Gate");
          write(path, "extra", "unmerged commit");
          yield* Effect.promise(() => commitAll(path, "extra"));
          expect(
            (yield* trees.cleanup(
              graph(accepted),
              root,
              [{ attempt: accepted, prepared }],
              new Set()
            ))[0]?.reason
          ).toContain("unmerged");
          yield* Effect.promise(() => gitText(root, ["merge", "--ff-only", prepared.branch]));
          write(path, "dirty", "uncommitted");
          expect(
            (yield* trees.cleanup(
              graph(accepted),
              root,
              [{ attempt: accepted, prepared }],
              new Set()
            ))[0]?.reason
          ).toContain("uncommitted");
          yield* Effect.promise(() => gitText(path, ["clean", "-f"]));
          expect(
            (yield* trees.cleanup(
              graph(accepted),
              root,
              [{ attempt: accepted, prepared }],
              new Set()
            ))[0]?.removed
          ).toBe(true);
          yield* trees.prepare(request);
          expect(existsSync(path)).toBe(false);
          expect(yield* trees.gate(root, root)).toMatchObject({ worktree: root, managed: false });
        })
      );
    } finally {
      removeTempDir(root);
      removeTempDir(`${root}.worktrees`);
    }
  },
  GIT_WORK_MS
);

test(
  "user-supplied worktrees are never removed, and changed placement ids refuse",
  async () => {
    const root = await makeRepo();
    const path = `${root}-user`;

    try {
      await gitText(root, ["worktree", "add", "-b", "user", path]);
      await run(
        Effect.gen(function* () {
          const trees = yield* ConstellationWorktrees;

          const request = WorktreeRequest.make({
            key: "user",
            constellationId: CID,
            task: task(),
            repoPath: root,
            leadPath: root,
            branchPrefix: "polaris",
            base: null,
            worktree: path,
            branch: null,
          });

          const prepared = yield* trees.prepare(request);
          expect(prepared.managed).toBe(false);
          expect(prepared.branch).toBe("user");

          const attempt = Attempt.make(
            Struct.assign(draft(A), {
              state: "accepted" as const,
              worktree: path,
              branch: "user",
            })
          );

          expect(
            (yield* trees.cleanup(graph(attempt), root, [{ attempt, prepared }], new Set()))[0]
              ?.reason
          ).toContain("supplied");
          expect(
            yield* trees
              .prepare(WorktreeRequest.make(Struct.assign(request, { branch: "other" })))
              .pipe(Effect.flip)
          ).toMatchObject({ code: "E-IDEMPOTENCY" });
        })
      );
    } finally {
      removeTempDir(path);
      removeTempDir(root);
    }
  },
  GIT_WORK_MS
);
