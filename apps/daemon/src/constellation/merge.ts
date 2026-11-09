/**
 * Accept's merge: the claimed head goes into the lead branch's checkout (`leadCheckout.ts`)
 * before the Accept is decided, with automatic git's safe config (no repository hooks, filters or merge drivers), signed
 * with the Host's own settings when `commit.gpgSign` asks (docs/adr/0068).
 */
import {
  type Attempt,
  type Constellation,
  type ConstellationFinding,
  ConstellationTransferError,
} from "@polaris/protocol";
import { Effect } from "effect";
import { type GitResult, gitText, HOOKS_OFF, resolveCommit, runGitRaw } from "../git/git.ts";
import {
  finishingGit,
  interruptibleGit,
  interruptSignal,
  uninterrupted,
} from "../git/interrupt.ts";
import { constellationRef, mergedInto } from "../git/constellationBundles.ts";
import { commitSigning, signingOptions } from "../git/signing.ts";
import { gitStatus } from "../git/status.ts";
import {
  bothChangeDependencies,
  regenerable,
  regenerate,
  restoreInstall,
  staleNotices,
  type Unregenerated,
} from "./regenerate.ts";

const refused = (code: string, message: string, fix: string) =>
  new ConstellationTransferError({ code, message, retryable: false, fix });

const failed = (cause: unknown) =>
  new ConstellationTransferError({
    code: "E-GIT",
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: true,
  });

const signFix = (place: string, branch: string, head: string) =>
  `Merge ${place} into ${branch} and sign it yourself, then accept with mergedHead ${head}.`;

/** Reads of the Lead's checkout: an interrupt kills their git. */
const git = <A>(f: () => Promise<A>) => interruptibleGit({ try: f, catch: failed });

export interface MergeOutcome {
  /** False when the Lead's branch already contained the claimed head. */
  readonly merged: boolean;
  readonly leadHead: string;
  /** What Accept records on the Task: notices a merge may have left stale (ENG-276). */
  readonly findings: ReadonlyArray<ConstellationFinding>;
}

const fetched = Effect.fnUntraced(function* (
  graph: Constellation,
  attempt: Attempt,
  leadPath: string,
  head: string
) {
  const local = yield* git(() => resolveCommit(leadPath, head));

  const remoteRef =
    attempt.hostId === graph.hostId
      ? head
      : yield* git(() => resolveCommit(leadPath, constellationRef(graph.id, attempt.id)));

  if (local !== head || remoteRef !== head)
    return yield* Effect.fail(
      new ConstellationTransferError({
        code: "E-GIT",
        message: `The claimed head ${head} has not been fetched into the Lead's repository`,
        retryable: true,
        fix: "Fetch the worker's branch from its Host, then accept again.",
      })
    );
});

/** Why the Lead's checkout can't take a merge now, with the step that clears it; null when it can. */
const leadBlocker = async (leadPath: string, place: string) => {
  const status = await gitStatus(leadPath);

  if (status.branch === null || status.head === null)
    return refused(
      "E-LEAD-DETACHED",
      `The lead checkout at ${leadPath} is not on a branch`,
      `Check out the Lead's branch, then accept again; Polaris merges ${place} there.`
    );

  if ((await resolveCommit(leadPath, "MERGE_HEAD")) !== null)
    return refused(
      "E-LEAD-MERGING",
      `The lead checkout at ${leadPath} already has a merge in progress on ${status.branch}`,
      `Finish or abort that merge, then accept again.`
    );

  const tracked = status.entries.filter((e) => e.index !== "?" && e.index !== "!");

  if (tracked.length > 0)
    return refused(
      "E-LEAD-DIRTY",
      `The lead checkout at ${leadPath} has uncommitted changes on ${status.branch}: ${tracked
        .slice(0, 5)
        .map((e) => e.path)
        .join(", ")}${tracked.length > 5 ? ` and ${tracked.length - 5} more` : ""}`,
      `Commit or stash them, then accept again; Polaris merges ${place} into ${status.branch}.`
    );

  return status.branch;
};

const conflicted = async (leadPath: string) =>
  (await gitText(leadPath, [...HOOKS_OFF, "diff", "--name-only", "--diff-filter=U"]))
    .split("\n")
    .filter((p) => p !== "");

/** Paths a failed merge left conflicted, then the merge undone so the Lead's tree is as it was. */
const abandon = async (leadPath: string) => {
  const conflicts = await conflicted(leadPath);

  if ((await resolveCommit(leadPath, "MERGE_HEAD")) !== null)
    await gitText(leadPath, [...HOOKS_OFF, "merge", "--abort"]);

  return conflicts;
};

interface Merged {
  readonly result: GitResult;
  /** Null when the merge went in; else the paths it left conflicted, now undone. */
  readonly conflicts: ReadonlyArray<string> | null;
  /** Why generated shared files weren't regenerated; empty when none were tried. */
  readonly unresolved?: string;
  /** True when the merge went in by regenerating its conflicts. */
  readonly regenerated?: boolean;
}

const untried: Unregenerated = { why: "", installed: false };

/**
 * A merge stopped only on generated shared files, regenerated and committed (ENG-276).
 * Null once committed; else why not, with an empty `why` when it wasn't tried.
 */
const regenerated = async (
  leadPath: string,
  commit: ReadonlyArray<string>
): Promise<Unregenerated | null> => {
  if ((await resolveCommit(leadPath, "MERGE_HEAD")) === null) return untried;
  const conflicts = await conflicted(leadPath);

  if (!regenerable(conflicts)) return untried;
  const failed = await regenerate(leadPath, conflicts);

  if (failed !== null) return failed;
  const committed = await runGitRaw(leadPath, commit);

  return committed.code === 0
    ? null
    : { why: `git commit failed: ${committed.stderr.trim()}`, installed: true };
};

/**
 * The merge, undone when it fails, so the Lead's checkout is merged or as it was. An
 * interrupt lets it finish (`finishingGit`); one killed past the deadline is undone too.
 */
const mergeOrRestore = async (
  leadPath: string,
  before: string,
  args: ReadonlyArray<string>,
  commit: ReadonlyArray<string>
): Promise<Merged> => {
  const result = await runGitRaw(leadPath, args);
  const killed = interruptSignal()?.aborted === true;

  return uninterrupted(async () => {
    if (result.code === 0) return { result, conflicts: null };

    // Killed after git moved the branch: the merge went in.
    if (killed && (await resolveCommit(leadPath, "HEAD")) !== before)
      return { result: { ...result, code: 0 }, conflicts: null };

    const unresolved = killed ? untried : await regenerated(leadPath, commit);

    if (unresolved === null)
      return { result: { ...result, code: 0 }, conflicts: null, regenerated: true };

    const conflicts = await abandon(leadPath);

    if (unresolved.installed) await restoreInstall(leadPath);

    // Killed before it committed: the index and work tree may hold half of it.
    if (killed && (await resolveCommit(leadPath, "MERGE_HEAD")) === null)
      await gitText(leadPath, [...HOOKS_OFF, "reset", "-q", "--merge", before]);

    return { result, conflicts, unresolved: unresolved.why };
  });
};

/**
 * Merges the claimed head into the Lead's current branch unless it already contains it.
 * Refuses, leaving the checkout as it was, on a dirty or detached Lead tree or a conflict.
 */
export const mergeClaim = Effect.fnUntraced(function* (
  graph: Constellation,
  attempt: Attempt,
  leadPath: string,
  head: string
): Effect.fn.Return<MergeOutcome, ConstellationTransferError> {
  if (attempt.claim === null || head !== attempt.claim.head)
    return yield* refused(
      "E-MERGED-HEAD",
      `${head} is not the claimed head ${attempt.claim?.head ?? "(no Claim)"}`,
      `Accept with mergedHead ${attempt.claim?.head ?? "of the current Claim"}.`
    );

  yield* fetched(graph, attempt, leadPath, head);

  if (yield* git(() => mergedInto(leadPath, head, "HEAD")))
    return {
      merged: false,
      leadHead: yield* git(() => gitText(leadPath, ["rev-parse", "HEAD"])),
      findings: [],
    };

  const place = `${attempt.branch} at ${head}`;
  const branch = yield* git(() => leadBlocker(leadPath, place));

  if (branch instanceof ConstellationTransferError) return yield* branch;

  const message = `Merge ${attempt.branch} (${attempt.taskId})`;
  const fastForward = yield* git(() => mergedInto(leadPath, "HEAD", head));
  const signing = fastForward ? null : yield* git(() => commitSigning(leadPath));

  if (signing?.kind === "refuse")
    return yield* refused(
      "E-MERGE-SIGN",
      `The merge of ${place} into ${branch} must be signed, and Polaris signs only with your own git config's settings: ${signing.reason}; nothing was merged`,
      signFix(place, branch, head)
    );

  // `--gpg-sign` keeps the commit signed even if commit.gpgSign changes meanwhile.
  const sign = signing === null ? [] : ["--gpg-sign"];

  const before = yield* git(() => gitText(leadPath, ["rev-parse", "HEAD"]));

  const {
    result,
    conflicts,
    unresolved,
    regenerated: resolved,
  } = yield* finishingGit({
    try: () =>
      mergeOrRestore(
        leadPath,
        before,
        [
          ...HOOKS_OFF,
          ...signingOptions(signing),
          "merge",
          "--ff",
          ...sign,
          "--no-edit",
          "-m",
          message,
          head,
        ],
        [...HOOKS_OFF, ...signingOptions(signing), "commit", ...sign, "--no-edit", "-q"]
      ),
    catch: failed,
  });

  if (conflicts !== null) {
    return yield* mergeFailure(
      { place, branch, head, conflicts, signed: signing !== null, unresolved: unresolved ?? "" },
      result
    );
  }

  const stale =
    resolved === true || (yield* git(() => bothChangeDependencies(leadPath, before, head)));

  return {
    merged: true,
    leadHead: yield* git(() => gitText(leadPath, ["rev-parse", "HEAD"])),
    findings: stale ? [staleNotices] : [],
  };
});

interface Failed {
  readonly place: string;
  readonly branch: string;
  readonly head: string;
  readonly conflicts: ReadonlyArray<string>;
  readonly signed: boolean;
  readonly unresolved: string;
}

/** Why the merge failed, once it's undone: a conflict, signing, or git's own words. */
const mergeFailure = (
  { place, branch, head, conflicts, signed, unresolved }: Failed,
  result: GitResult
) => {
  const stderr = result.stderr.trim();
  const regenerating = unresolved === "" ? "" : ` (regenerating them failed: ${unresolved})`;

  if (conflicts.length > 0)
    return refused(
      "E-MERGE-CONFLICT",
      `Merging ${place} into ${branch} conflicts in ${conflicts.slice(0, 5).join(", ")}${regenerating}; nothing was merged`,
      `Send it back with mergeConflictBase ${branch} so the worker merges ${branch} first, or merge it into ${branch} yourself, then accept with mergedHead ${head}.`
    );

  if (signed && stderr.includes("failed to write commit object"))
    return refused(
      "E-MERGE-SIGN",
      `git could not sign the merge of ${place} into ${branch}; nothing was merged: ${stderr}`,
      signFix(place, branch, head)
    );

  return refused(
    "E-GIT",
    `git merge of ${place} into ${branch} failed: ${stderr}`,
    `Merge ${place} into ${branch} yourself, then accept with mergedHead ${head}.`
  );
};
