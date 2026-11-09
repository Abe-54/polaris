/**
 * The checkout that holds a Constellation's lead branch: where Accept merges and a Gate runs.
 * Never the Workspace root's current branch unless that is the lead branch (docs/adr/0099).
 */
import { existsSync } from "node:fs";
import { type Constellation, ConstellationTransferError } from "@polaris/protocol";
import { gitText, HOOKS_OFF, resolveCommit } from "../git/git.ts";
import { gitStatus } from "../git/status.ts";
import { listWorktrees, samePath } from "../git/WorktreeTracker.ts";

/** `@` keeps it apart from Task worktrees, whose IDs are plain path components. */
export const leadWorktreePath = (leadPath: string, constellationId: string) =>
  `${leadPath}.worktrees/${constellationId}/@lead`;

/** The ref new work branches from and merges are checked against: the lead branch, else HEAD. */
export const leadRef = (graph: Constellation) =>
  graph.leadBranch === undefined ? "HEAD" : `refs/heads/${graph.leadBranch}`;

/** The branch the Lead's checkout is on, recorded when a graph starts; null when detached. */
export const currentBranch = async (leadPath: string) => (await gitStatus(leadPath)).branch;

const refused = (code: string, message: string, fix: string) =>
  new ConstellationTransferError({ code, message, retryable: false, fix });

/**
 * The checkout already on the lead branch, else the Daemon-owned lead worktree, created or
 * switched to it. A graph without a recorded lead branch keeps the Lead's own checkout.
 */
export const leadCheckout = async (
  graph: Constellation,
  leadPath: string
): Promise<string | ConstellationTransferError> => {
  const branch = graph.leadBranch;

  if (branch === undefined) return leadPath;

  const worktrees = await listWorktrees(leadPath);
  const holder = worktrees.find((w) => w.branch === branch);

  if (holder !== undefined) return holder.path;

  if ((await resolveCommit(leadPath, `refs/heads/${branch}`)) === null)
    return refused(
      "E-LEAD-BRANCH",
      `The lead branch ${branch} no longer exists`,
      `Recreate ${branch} at the integrated work, then accept again.`
    );

  const path = leadWorktreePath(leadPath, graph.id);
  const registered = worktrees.find((w) => samePath(w.path, path));

  if (registered !== undefined) {
    // Moved off the lead branch: switch back; git refuses when that would lose changes.
    await gitText(path, [...HOOKS_OFF, "checkout", "--quiet", branch]);

    return path;
  }

  if (existsSync(path))
    return refused(
      "E-LEAD-WORKTREE",
      `${path} holds a directory git doesn't know as a worktree`,
      `Move it aside, then accept again; Polaris checks out ${branch} there.`
    );

  await gitText(leadPath, [...HOOKS_OFF, "worktree", "add", "--quiet", path, branch]);

  return path;
};
