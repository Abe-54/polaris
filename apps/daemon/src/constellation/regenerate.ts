/**
 * Accept's merge regenerates the root `bun.lock` instead of refusing on its conflict, and
 * keeps the Lead's notices, which it never regenerates: it runs no repository code (ENG-276).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConstellationFinding } from "@polaris/protocol";
import { gitText, HOOKS_OFF, runGitRaw } from "../git/git.ts";
import { executableOf, findExecutable } from "../platform/executable.ts";

export const LOCKFILE = "bun.lock";

export const NOTICES = "THIRD_PARTY_NOTICES.md";

const REGENERATE_MS = 5 * 60_000;

/** The finding Accept records when a merge may leave the notices stale. */
export const staleNotices = ConstellationFinding.make({
  code: "NOTICES-STALE",
  message: "Notices may be stale",
  fix: "run `bun run licenses` on the lead branch",
});

/** True when every conflicted path is one the merge can resolve without running repo code. */
export const regenerable = (conflicts: ReadonlyArray<string>) =>
  conflicts.length > 0 && conflicts.every((path) => path === LOCKFILE || path === NOTICES);

const isDependencyFile = (path: string) =>
  path === LOCKFILE || path === "package.json" || path.endsWith("/package.json");

/** Files bun install reads on its own, in any directory and any case (macOS ignores it). */
const isBunConfig = (path: string) => {
  const name = (path.split("/").at(-1) ?? "").normalize("NFC").toLowerCase();

  return name === "bunfig.toml" || name === ".npmrc" || name === ".env" || name.startsWith(".env.");
};

/**
 * Why the merged branch can't be installed from; null when it can: it changes bun's config,
 * adds a symlink, or writes under node_modules.
 */
const unsafeToInstall = async (root: string) => {
  const raw = (
    await gitText(root, [...HOOKS_OFF, "diff", "--raw", "--no-renames", "HEAD...MERGE_HEAD"])
  )
    .split("\n")
    .filter((line) => line !== "");

  const refused = raw.flatMap((line) => {
    const [meta = "", path = ""] = line.split("\t");
    const mode = meta.split(" ")[1] ?? "";
    const lower = path.toLowerCase();

    return mode === "120000" || isBunConfig(path) || lower.split("/").includes("node_modules")
      ? [path]
      : [];
  });

  return refused.length === 0 ? null : `the merged branch changes ${refused.join(", ")}`;
};

const changedFiles = async (root: string, range: string) =>
  (await gitText(root, [...HOOKS_OFF, "diff", "--name-only", range]))
    .split("\n")
    .filter((p) => p !== "");

/** True when both sides of `base..ours` and `base..theirs` change a manifest or the lockfile. */
export const bothChangeDependencies = async (root: string, ours: string, theirs: string) => {
  const base = await gitText(root, [...HOOKS_OFF, "merge-base", ours, theirs]);

  return (
    (await changedFiles(root, `${base}..${ours}`)).some(isDependencyFile) &&
    (await changedFiles(root, `${base}..${theirs}`)).some(isDependencyFile)
  );
};

const install = async (cwd: string, bun: string) => {
  const proc = Bun.spawn([executableOf(bun), "install", "--ignore-scripts"], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: REGENERATE_MS,
    killSignal: "SIGKILL",
  });

  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  return code === 0 ? null : `bun install --ignore-scripts failed (${code}): ${stderr.trim()}`;
};

/** Puts node_modules back to the Lead's lockfile after a failed regeneration. */
export const restoreInstall = async (root: string) => {
  const bun = findExecutable("bun");

  if (bun !== null) await install(root, bun);
};

/** Why a regeneration stopped, and whether it had already changed node_modules. */
export interface Unregenerated {
  readonly why: string;
  readonly installed: boolean;
}

/**
 * In a merge stopped on `conflicts`, takes the Lead's side of each, regenerates the lockfile
 * with `bun install --ignore-scripts`, and stages them. Null once resolved and staged.
 */
export const regenerate = async (
  root: string,
  conflicts: ReadonlyArray<string>
): Promise<Unregenerated | null> => {
  const before = (why: string) => ({ why, installed: false });
  const bun = findExecutable("bun");

  if (conflicts.includes(LOCKFILE) && bun === null)
    return before("bun is not on the Daemon's PATH");

  const unsafe = await unsafeToInstall(root);

  if (unsafe !== null) return before(unsafe);
  await gitText(root, [...HOOKS_OFF, "checkout", "--ours", "--", ...conflicts]);

  if (conflicts.includes(LOCKFILE) && bun !== null) {
    const failed = await install(root, bun);

    if (failed !== null) return { why: failed, installed: true };
  }

  const staged = existsSync(join(root, LOCKFILE))
    ? [...new Set([...conflicts, LOCKFILE])]
    : conflicts;

  const added = await runGitRaw(root, [...HOOKS_OFF, "add", "--", ...staged]);

  return added.code === 0
    ? null
    : { why: `git add failed: ${added.stderr.trim()}`, installed: conflicts.includes(LOCKFILE) };
};
