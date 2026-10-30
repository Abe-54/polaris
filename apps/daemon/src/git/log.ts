/**
 * `git.log`: the newest commits from HEAD, for the Commit messages preview in Settings.
 * Read-only under the safe config, so no hook or configured command runs.
 */
import { NotARepository } from "./diff.ts";
import { findRepoRoot, resolveHead, runGit } from "./git.ts";

const LOG_TIMEOUT_MS = 15_000;

/** Five NUL-terminated fields per commit: sha, author, author date, subject, body. */
const FORMAT = "--format=%H%x00%an%x00%aI%x00%s%x00%b%x00";

const FIELDS = 5;

export interface LogCommit {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly author: string;
  readonly date: string;
}

/** Splits `git log` output in `FORMAT`; git puts a newline between commits, before each sha. */
export const parseLog = (output: string): ReadonlyArray<LogCommit> => {
  const fields = output.split("\0");
  const commits: Array<LogCommit> = [];

  for (let at = 0; at + FIELDS <= fields.length; at += FIELDS) {
    const [sha, author, date, subject, body] = fields.slice(at, at + FIELDS);
    const trimmed = sha!.trim();

    if (trimmed === "") break;
    commits.push({
      sha: trimmed,
      author: author!,
      date: date!,
      subject: subject!,
      body: body!.replace(/\s+$/, ""),
    });
  }

  return commits;
};

/** Newest first; empty on an unborn branch. Works from a linked worktree's own checkout. */
export const gitLog = async (cwd: string, limit: number): Promise<ReadonlyArray<LogCommit>> => {
  const root = await findRepoRoot(cwd);

  if (root === null) throw new NotARepository(cwd);

  if ((await resolveHead(root)) === null) return [];

  const { stdout } = await runGit(
    root,
    ["log", "--no-show-signature", "--no-color", `--max-count=${limit}`, FORMAT, "HEAD", "--"],
    { timeoutMs: LOG_TIMEOUT_MS }
  );

  return parseLog(new TextDecoder().decode(stdout));
};
