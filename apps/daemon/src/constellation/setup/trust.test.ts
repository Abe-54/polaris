import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PreparedWorktree, SessionId, WorkerPlacement, WorktreeSetup } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { makeFakeDriver } from "../../engine/testing.ts";
import { CID, HOST, WS, planned, task } from "../../engine/constellation.testing.ts";
import { makeRepo, removeTempDir, tempDir } from "../../git/testing.ts";
import { HarnessRegistry } from "../../services.ts";
import { EventStore } from "../../store/EventStore.ts";
import { prepareSession } from "../composition/prepare.ts";
import { ConstellationOwner } from "../runtime.ts";
import { WorktreeSetupService, WorktreeSetupTrust } from "./index.ts";
import { changeTrust } from "./trust.testing.ts";
import { posixTest } from "../../platform/testing.ts";

const shellSetupTest = posixTest(
  "setup commands here are POSIX shell lines; Windows runs setup under cmd.exe (ENG-318)"
);

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

/** The real Trust layer over a private Daemon directory, as the Constellation composition builds it. */
const fixture = (state: string) =>
  WorktreeSetupService.layer.pipe(
    Layer.provideMerge(WorktreeSetupTrust.layer(state)),
    Layer.provideMerge(
      Layer.mergeAll(
        EventStore.layerSqlite(join(state, "state.sqlite")),
        Layer.succeed(ConstellationOwner)(HOST),
        Layer.succeed(HarnessRegistry)({
          get: () => Effect.succeed(makeFakeDriver("codex").driver),
          all: Effect.succeed([]),
        })
      )
    )
  );

const dispatch = (repo: string, key: string, worktreeSetup: WorktreeSetup | null) =>
  prepareSession(
    {
      key,
      graph: planned([task()]).graph,
      task: task(),
      previous: null,
      placement: WorkerPlacement.cases.New.make({ hostId: HOST }),
      worktree: PreparedWorktree.make({
        worktree: repo,
        repoPath: repo,
        branch: "main",
        base: "HEAD",
        managed: true,
        managedBranch: true,
      }),
      worktreeSetup,
    },
    HOST
  );

// `echo ran > ran` creates the file under both /bin/sh and cmd.exe, where setup runs on Windows.
const setups = [
  ["a lockfile-detected install", null],
  ["a custom command", WorktreeSetup.cases.Command.make({ command: "echo ran > ran" })],
] as const;

test.each(setups)(
  "an untrusted workspace refuses dispatch before %s runs, and trusting it lets setup run",
  async (_name, setting) => {
    const repo = await makeRepo();
    const state = tempDir("polaris-state-");
    cleanup.push(repo, state);
    await writeFile(join(repo, "package.json"), '{"scripts":{"preinstall":"touch ran"}}');
    await writeFile(join(repo, "bun.lock"), "");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const refused = yield* dispatch(repo, "untrusted:A", setting).pipe(Effect.flip);
          expect(refused.findings.map((f) => f.code)).toEqual(["E-SETUP-TRUST"]);
          expect(existsSync(join(repo, "ran"))).toBe(false);

          const store = yield* EventStore;
          const worker = (yield* store.model).sessions.get(SessionId.make("untrusted:A:worker"));
          expect(worker?.session.worktreeSetup ?? null).toBeNull();
          expect(worker?.turns ?? []).toHaveLength(0);

          yield* changeTrust(state, HOST, WS, "trust");
          yield* dispatch(
            repo,
            "trusted:A",
            WorktreeSetup.cases.Command.make({ command: "echo ran > ran" })
          );
          expect(existsSync(join(repo, "ran"))).toBe(true);
        })
      ).pipe(Effect.provide(fixture(state)))
    );
  },
  20_000
);

shellSetupTest(
  "revoking trust stops setup at the spawn boundary, even for a forced retry",
  async () => {
    const repo = await makeRepo();
    const state = tempDir("polaris-state-");
    cleanup.push(repo, state);
    const setting = WorktreeSetup.cases.Command.make({ command: "echo run >> count" });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* dispatch(repo, "seed:A", WorktreeSetup.cases.Disabled.make({}));
          yield* changeTrust(state, HOST, WS, "trust");
          const attempt = yield* dispatch(repo, "first:A", setting);

          yield* changeTrust(state, HOST, WS, "revoke");

          const refused = yield* (yield* WorktreeSetupService)
            .run(attempt.sessionId, "merge-conflict", repo, setting, CID, task().id, WS, true)
            .pipe(Effect.flip);

          expect(refused._tag).toBe("WorktreeSetupUntrusted");
          expect(yield* Effect.promise(() => readFile(join(repo, "count"), "utf8"))).toBe("run\n");
        })
      ).pipe(Effect.provide(fixture(state)))
    );
  },
  20_000
);
