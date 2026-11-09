/**
 * Accept's merge regenerates the root `bun.lock` instead of refusing on its conflict, and
 * keeps the Lead's notices, which it never regenerates: it runs no repository code (ENG-276).
 */
import { ConstellationFinding } from "@polaris/protocol";
import { gitText, HOOKS_OFF, runGitRaw } from "../git/git.ts";
import { executableOf, findExecutable } from "../platform/executable.ts";
import { addedOffRegistry } from "./specifiers.ts";

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

/** A manifest by name in any case, since macOS's file system ignores case. */
const isManifest = (path: string) =>
  (path.split("/").at(-1) ?? "").normalize("NFC").toLowerCase() === "package.json";

const isDependencyFile = (path: string) => path === LOCKFILE || isManifest(path);

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
  // -z: paths unquoted, NUL-separated, as `:<old mode> <new mode> … <status>` then the path.
  const fields = (
    await gitText(root, [...HOOKS_OFF, "diff", "--cached", "--raw", "-z", "--no-renames", "HEAD"])
  ).split("\0");

  const refused: Array<string> = [];
  const manifests: Array<string> = [];

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const mode = fields[i]?.split(" ")[1] ?? "";
    const path = fields[i + 1] ?? "";
    const segments = path.normalize("NFC").toLowerCase().split("/");

    if (mode === "120000" || isBunConfig(path) || segments.includes("node_modules"))
      refused.push(path);

    if (isManifest(path)) manifests.push(path);
  }

  if (refused.length > 0) return `the merged branch changes ${refused.join(", ")}`;

  const offRegistry = await addedOffRegistry(root, manifests);

  return offRegistry.length === 0
    ? null
    : `the merged branch adds dependencies from outside the registry (${offRegistry.join(", ")})`;
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
  const proc = Bun.spawn([executableOf(bun), "install", "--lockfile-only", "--ignore-scripts"], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: REGENERATE_MS,
    killSignal: "SIGKILL",
  });

  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  return code === 0 ? null : `bun install --lockfile-only failed (${code}): ${stderr.trim()}`;
};

/**
 * In a merge stopped on `conflicts`, takes the Lead's side of each, rewrites the lockfile with
 * `bun install --lockfile-only --ignore-scripts` (no node_modules, no code), and stages them.
 * Returns why it couldn't, or null once resolved and staged.
 */
export const regenerate = async (
  root: string,
  conflicts: ReadonlyArray<string>
): Promise<string | null> => {
  const bun = findExecutable("bun");

  if (conflicts.includes(LOCKFILE) && bun === null) return "bun is not on the Daemon's PATH";

  await gitText(root, [...HOOKS_OFF, "checkout", "--ours", "--", ...conflicts]);

  // The merged index, which is what bun reads, against the Lead's HEAD.
  const unsafe = await unsafeToInstall(root);

  if (unsafe !== null) return unsafe;

  if (conflicts.includes(LOCKFILE) && bun !== null) {
    const failed = await install(root, bun);

    if (failed !== null) return failed;
  }

  const added = await runGitRaw(root, [...HOOKS_OFF, "add", "--", ...conflicts]);

  return added.code === 0 ? null : `git add failed: ${added.stderr.trim()}`;
};
