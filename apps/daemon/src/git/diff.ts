/**
 * Unified diffs for `git.diff`: the working tree (untracked files included),
 * one Turn (between its checkpoint refs), or an arbitrary range.
 */
import { type DiffFile, GitDiff } from "@polaris/protocol";
import { checkpointRef } from "./Checkpoints.ts";
import { indexDiff } from "./diffIndex.ts";
import { emptyTree, findRepoRoot, GitOutputTooLarge, resolveCommit, runGit } from "./git.ts";
import { megabytes } from "./output.ts";
import { snapshotWorkingTree } from "./snapshot.ts";

/** What `git.diff` compares: the protocol's tagged union, with its `cases` constructors. */
export const DiffSpec = GitDiff.payloadSchema.fields.spec;

export type DiffSpec = typeof DiffSpec.Type;

type WorkingTreeSpec = typeof DiffSpec.cases.WorkingTree.Type;

type TurnSpec = typeof DiffSpec.cases.Turn.Type;

type RangeSpec = typeof DiffSpec.cases.Range.Type;

type TurnsSpec = typeof DiffSpec.cases.Turns.Type;

export class DiffNotFound extends Error {
  constructor(
    readonly what: string,
    readonly id: string
  ) {
    super(`${what} not found: ${id}`);
  }
}

export class NotARepository extends Error {
  constructor(readonly cwd: string) {
    super(`not a git repository: ${cwd}`);
  }
}

export interface DiffResult {
  readonly bytes: Uint8Array;
  /** How many files the patch holds: its `diff --git` headers. */
  readonly files: number;
  /** Each file's byte range in `bytes` and its line counts, in patch order. */
  readonly index: ReadonlyArray<DiffFile>;
  readonly root: string;
  /**
   * Where `.gitattributes` and `.polaris/review.md` are read: a range's base, so a change
   * can't mark its own code generated; null (the working tree) for the working tree and Turns.
   */
  readonly rulesAt: string | null;
}

const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "-M"] as const;

/** The largest diff `git.diff` reads; past it git is stopped and the diff reads as too large. */
export const MAX_DIFF_BYTES = 64 * 1024 * 1024;

const DIFF_TIMEOUT_MS = 120_000;

/** Rethrows a diff that passed its limit with the words the Desktop App shows. */
export const diffTooLarge = (cause: unknown): never => {
  if (cause instanceof GitOutputTooLarge) {
    throw new GitOutputTooLarge(
      cause.args,
      cause.limit,
      `This diff is larger than ${megabytes(cause.limit)}, too large to show`
    );
  }

  throw cause;
};

const diffTrees = async (root: string, from: string, to: string): Promise<DiffResult> => {
  const { stdout } = await runGit(root, [...DIFF_FLAGS, from, to, "--"], {
    maxOutputBytes: MAX_DIFF_BYTES,
    timeoutMs: DIFF_TIMEOUT_MS,
  }).catch(diffTooLarge);

  const index = indexDiff(stdout);

  return { bytes: stdout, files: index.length, index, root, rulesAt: null };
};

const requireCommit = async (root: string, ref: string, what: string): Promise<string> => {
  const commit = await resolveCommit(root, ref);

  if (commit === null) throw new DiffNotFound(what, ref);

  return commit;
};

/** The snapshot already knows the top level and HEAD: neither is asked of git again. */
const diffWorkingTree = async (cwd: string, spec: WorkingTreeSpec) => {
  const snapshot = await snapshotWorkingTree(cwd);

  if (snapshot === null) throw new NotARepository(cwd);
  const { root } = snapshot;

  const base =
    spec.base !== null
      ? await requireCommit(root, spec.base, "ref")
      : (snapshot.head ?? (await emptyTree(root)));

  return diffTrees(root, base, snapshot.tree);
};

const diffTurn = async (cwd: string, root: string, spec: TurnSpec) => {
  const before = await requireCommit(
    root,
    checkpointRef(spec.sessionId, spec.turnId, "before"),
    "checkpoint"
  );

  // A Turn still in progress has no `after` yet: diff against the working tree now.
  const after =
    (await resolveCommit(root, checkpointRef(spec.sessionId, spec.turnId, "after"))) ??
    (await snapshotWorkingTree(root))?.tree;

  if (after === undefined) throw new NotARepository(cwd);

  return diffTrees(root, before, after);
};

/** A run of Turns: the first one's before-checkpoint to the last one's after (or the working tree). */
const diffTurns = async (cwd: string, root: string, spec: TurnsSpec) => {
  const before = await requireCommit(
    root,
    checkpointRef(spec.sessionId, spec.firstTurnId, "before"),
    "checkpoint"
  );

  const after =
    (await resolveCommit(root, checkpointRef(spec.sessionId, spec.lastTurnId, "after"))) ??
    (await snapshotWorkingTree(root))?.tree;

  if (after === undefined) throw new NotARepository(cwd);

  return diffTrees(root, before, after);
};

const diffRange = async (root: string, spec: RangeSpec) => {
  const base = await requireCommit(root, spec.base, "ref");
  const head = await requireCommit(root, spec.head, "ref");

  return { ...(await diffTrees(root, base, head)), rulesAt: base };
};

const requireRoot = async (cwd: string): Promise<string> => {
  const root = await findRepoRoot(cwd);

  if (root === null) throw new NotARepository(cwd);

  return root;
};

export const computeDiff = (cwd: string, spec: DiffSpec): Promise<DiffResult> =>
  DiffSpec.match(spec, {
    WorkingTree: (workingTree) => diffWorkingTree(cwd, workingTree),
    Turn: async (turn) => diffTurn(cwd, await requireRoot(cwd), turn),
    Range: async (range) => diffRange(await requireRoot(cwd), range),
    Turns: async (turns) => diffTurns(cwd, await requireRoot(cwd), turns),
  });
