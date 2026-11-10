/**
 * git: checkpoints and diffs on a large working tree (full: 50k files).
 *
 * A scripted Turn edits 20 files, so the engine captures real `before` and
 * `after` checkpoints (`git add -A` into a temporary index, `write-tree`,
 * `commit-tree`, `update-ref`). Then the Turn's diff, `git.status` and a
 * working-tree diff go through the RPCs a Client uses. Last, an ignored
 * `node_modules` is added and `git.status` runs as the explorer asks for it.
 *
 *   checkpoint_before: SendTurn dispatch → `CheckpointRecorded(before)` at the Client
 *   checkpoint_after:  the Turn's last item → `CheckpointRecorded(after)` at the Client
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitDiff, SessionId } from "@polaris/protocol";
import { Effect, Option, Predicate, Stream } from "effect";
import { awaitReady, cleanup, connect, createTempDir } from "../daemon.ts";
import {
  registerWorkspace,
  sendTurn,
  settle,
  startSession,
  type TurnScript,
  waitUntil,
  watchSession,
} from "../drive.ts";
import { copyTree, git, sourceTree } from "../fixtures.ts";
import { median } from "../stats.ts";
import { cpu, type Metric, peakMemory, rss, type Scenario, time } from "../types.ts";

const DiffSpec = GitDiff.payloadSchema.fields.spec;

/** An ignored `node_modules` (via `.git/info/exclude`, so nothing is committed): 50 packages. */
const addIgnoredTree = (repo: string, files: number): number => {
  writeFileSync(join(repo, ".git", "info", "exclude"), "node_modules/\n");

  for (let i = 0; i < files; i++) {
    const dir = join(repo, "node_modules", `pkg-${i % 50}`, "lib");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${i}.js`), "module.exports = 1;\n");
  }

  return files;
};

export const gitScenario: Scenario = {
  name: "git",
  description: "checkpoint capture, Turn diff, status on a large working tree",
  run: (ctx) =>
    Effect.gen(function* () {
      const count = ctx.quick ? 5_000 : 50_000;
      const turns = ctx.quick ? 3 : 5;
      ctx.log(`git: preparing a ${count}-file repo (cached after the first run)…`);
      const source = sourceTree(count);

      const dir = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("git")),
        (d) => Effect.sync(() => cleanup(d))
      );

      const repo = copyTree(source, join(dir, "repo"));
      // A copy has new inodes and mtimes; refresh the index as a normal checkout would have it.
      git(repo, "update-index", "-q", "--refresh");

      const daemon = yield* ctx.launch();
      yield* awaitReady(daemon);
      const sampler = yield* ctx.sample(daemon, 100);
      const client = yield* connect(daemon, ctx.transport, "git");
      const workspaceId = yield* registerWorkspace(client, repo, "git");
      const script: TurnScript = { items: 2, deltasPerItem: 0, touchFiles: 20 };

      const sessionId = "git-0";
      yield* startSession(client, { sessionId, workspaceId, script });
      const watch = yield* watchSession(client, sessionId);
      const dispatchedAt: Array<number> = [];

      for (let turn = 1; turn <= turns; turn++) {
        yield* waitUntil(
          () => watch.turnEnded.length >= turn && watch.state === "idle",
          300_000,
          `Turn ${turn}`
        );

        if (turn < turns) {
          yield* settle(200);
          dispatchedAt.push(performance.now());
          yield* sendTurn(client, sessionId, script);
        }
      }

      const befores = watch.checkpoints.filter((c) => c.ref.endsWith("/before"));
      const afters = watch.checkpoints.filter((c) => c.ref.endsWith("/after"));

      // Turn 1's before-checkpoint is committed before we subscribe: time Turns 2… only.
      const before = dispatchedAt.map(
        (t, i) => (befores[befores.length - dispatchedAt.length + i]?.at ?? t) - t
      );

      const after = afters.map((c) => c.at - c.lastItemAt);
      const turnReport = sampler.report();

      const rpc = client.connection.client;

      const snapshot = yield* rpc
        .subscribeSession({
          sessionId: SessionId.make(sessionId),
          afterSequence: null,
          turnLimit: 1,
        })
        .pipe(Stream.runHead);

      const first = Option.getOrUndefined(snapshot);

      const turnId =
        first !== undefined && Predicate.isTagged(first, "Snapshot")
          ? first.turns.at(-1)?.turn.id
          : undefined;

      if (turnId === undefined) return yield* Effect.die(new Error("no Turn in the snapshot"));

      const turnSpec = DiffSpec.cases.Turn.make({ sessionId: SessionId.make(sessionId), turnId });
      const workingTreeSpec = DiffSpec.cases.WorkingTree.make({ base: null });

      const timed = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const t = performance.now();
          const value = yield* effect;

          return { value, ms: performance.now() - t };
        });

      const turnDiff = yield* timed(
        Effect.gen(function* () {
          const diff = yield* rpc["git.diff"]({ cwd: repo, spec: turnSpec });

          const bytes = yield* client.connection.blobs.take(diff.blobId);

          return { files: diff.files, bytes: bytes.byteLength };
        })
      );

      const status = yield* timed(rpc["git.status"]({ cwd: repo }));

      const workingDiff = yield* timed(
        Effect.gen(function* () {
          const diff = yield* rpc["git.diff"]({ cwd: repo, spec: workingTreeSpec });

          yield* client.connection.blobs.take(diff.blobId);

          return diff.files;
        })
      );

      const ignoredFiles = addIgnoredTree(repo, ctx.quick ? 500 : 5_000);
      const ignoredStatus = yield* timed(rpc["git.status"]({ cwd: repo, ignored: true }));

      const all = sampler.report();

      const metrics: Record<string, Metric> = {};

      Object.assign(metrics, {
        checkpoint_before_ms: time(median(before)),
        checkpoint_after_ms: time(median(after)),
        turn_diff_ms: time(turnDiff.ms),
        status_ms: time(status.ms),
        status_ignored_ms: time(ignoredStatus.ms),
        working_tree_diff_ms: time(workingDiff.ms),
        turns_cpu_avg_pct: cpu(turnReport.cpuAvgPct, { info: true }),
        rss_peak_mib: rss(peakMemory(all.rssBytes.max)),
      } satisfies Record<string, Metric>);

      if (all.footprintBytes) metrics.footprint_peak_mib = peakMemory(all.footprintBytes.max);

      return {
        metrics,
        notes: [
          `${count} files; ${turns} Turns each rewriting 20 files; before-checkpoint timed on Turns 2–${turns}`,
          `Turn diff: ${turnDiff.value.files} file(s), ${turnDiff.value.bytes} bytes; status: ${status.value.entries.length} entries; working-tree diff: ${workingDiff.value} file(s)`,
          `status with ignored: ${ignoredStatus.value.entries.length} entries over ${ignoredFiles} ignored files`,
          ...(turnDiff.value.files === 0
            ? [
                "the Turn diff reported 0 files: see git/README.md (the file index gets an ArrayBuffer)",
              ]
            : []),
        ],
      };
    }),
};
