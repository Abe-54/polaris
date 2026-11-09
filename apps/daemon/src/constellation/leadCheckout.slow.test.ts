import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Attempt, Constellation, ConstellationSettings } from "@polaris/protocol";
import { Effect, Layer, Struct } from "effect";
import { gitText } from "../git/git.ts";
import { commitAll, makeRepo, removeTempDir, write } from "../git/testing.ts";
import { AT, CID, HOST, LEAD, WS, draft, report } from "../engine/constellation.testing.ts";
import { leadWorktreePath } from "./leadCheckout.ts";
import { TransferStorage } from "./transfers/storage.ts";
import { ConstellationWorktrees } from "./worktrees.ts";

const GIT_WORK_MS = 15_000;

/** A Lead repository with lead branch `integration` and a worker branch `polaris/A` off it. */
const setup = async () => {
  const root = await makeRepo({ "README.md": "hello\n" });
  await gitText(root, ["branch", "integration"]);
  await gitText(root, ["checkout", "-q", "-b", "polaris/A", "integration"]);
  write(root, "work.txt", "worker\n");
  const head = await commitAll(root, "worker");
  await gitText(root, ["checkout", "-q", "main"]);

  const attempt = Attempt.make(
    Struct.assign(draft(), { state: "review" as const, claim: report("polaris/A", head) })
  );

  const graph = Constellation.make({
    id: CID,
    hostId: HOST,
    leadSessionId: LEAD,
    leadBranch: "integration",
    workspaceId: WS,
    name: "test",
    state: "running",
    revision: 1,
    settings: ConstellationSettings.make({}),
    tasks: [],
    attempts: [attempt],
    pendingNotifications: [],
    createdAt: AT,
    updatedAt: AT,
  });

  return { root, head, attempt, graph };
};

const run = <T, E>(program: Effect.Effect<T, E, ConstellationWorktrees>) =>
  Effect.runPromise(
    program.pipe(
      Effect.match({ onFailure: (error) => ({ error }), onSuccess: (ok) => ({ ok }) }),
      Effect.provide(
        ConstellationWorktrees.layer.pipe(Layer.provide(TransferStorage.layer(":memory:")))
      )
    )
  );

const withRepo = (body: (s: Awaited<ReturnType<typeof setup>>) => Promise<void>) => async () => {
  const s = await setup();

  try {
    await body(s);
  } finally {
    removeTempDir(s.root);
    removeTempDir(`${s.root}.worktrees`);
  }
};

test(
  "accept while the Workspace root is on another branch leaves the root untouched and lands on the lead branch",
  withRepo(async (s) => {
    await gitText(s.root, ["checkout", "-q", "-b", "someone-else"]);
    write(s.root, "README.md", "another session's edit\n");
    const rootHead = await gitText(s.root, ["rev-parse", "HEAD"]);

    const result = await run(
      Effect.gen(function* () {
        return yield* (yield* ConstellationWorktrees).mergeClaim(
          s.graph,
          s.attempt,
          s.root,
          s.head
        );
      })
    );

    expect(result).toEqual({ ok: { merged: true, leadHead: s.head } });
    expect(await gitText(s.root, ["rev-parse", "refs/heads/integration"])).toBe(s.head);
    expect(await gitText(s.root, ["branch", "--show-current"])).toBe("someone-else");
    expect(await gitText(s.root, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(readFileSync(join(s.root, "README.md"), "utf8")).toBe("another session's edit\n");
    expect(existsSync(join(s.root, "work.txt"))).toBe(false);

    const lead = leadWorktreePath(s.root, CID);
    expect(await gitText(lead, ["branch", "--show-current"])).toBe("integration");

    // The Gate verifies the integrated work, not the root's branch.
    const gate = await run(
      Effect.gen(function* () {
        return yield* (yield* ConstellationWorktrees).gate(s.graph, s.root);
      })
    );

    expect(gate).toMatchObject({ ok: { worktree: lead, branch: "integration", base: s.head } });
  }),
  GIT_WORK_MS
);

test(
  "a checkout already on the lead branch takes the merge there, without a second worktree",
  withRepo(async (s) => {
    await gitText(s.root, ["checkout", "-q", "integration"]);

    const result = await run(
      Effect.gen(function* () {
        return yield* (yield* ConstellationWorktrees).mergeClaim(
          s.graph,
          s.attempt,
          s.root,
          s.head
        );
      })
    );

    expect(result).toEqual({ ok: { merged: true, leadHead: s.head } });
    expect(readFileSync(join(s.root, "work.txt"), "utf8")).toBe("worker\n");
    expect(existsSync(leadWorktreePath(s.root, CID))).toBe(false);
  }),
  GIT_WORK_MS
);

test(
  "a deleted lead branch refuses the merge and touches nothing",
  withRepo(async (s) => {
    await gitText(s.root, ["branch", "-D", "integration"]);

    const result = await run(
      Effect.gen(function* () {
        return yield* (yield* ConstellationWorktrees).mergeClaim(
          s.graph,
          s.attempt,
          s.root,
          s.head
        );
      })
    );

    expect(result).toMatchObject({ error: { code: "E-LEAD-BRANCH" } });
    expect(await gitText(s.root, ["rev-parse", "HEAD"])).not.toBe(s.head);
    expect(existsSync(leadWorktreePath(s.root, CID))).toBe(false);
  }),
  GIT_WORK_MS
);
