/** The directories of a checkout that discovery reads: its root and the packages inside it (ENG-726). */
import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { type GitOptions, mayBeInWorkTree, runGitRaw } from "../git/git.ts";

/** Package directories read below the root, shallowest first. */
export const PACKAGE_LIMIT = 64;

/** Path segments a package directory may have (`apps/web` is two). */
export const PACKAGE_DEPTH = 4;

const MANIFESTS = new Set([
  "package.json",
  "deno.json",
  "pyproject.toml",
  "requirements.txt",
  "manage.py",
  "Gemfile",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "mix.exs",
  "schema.prisma",
  "drizzle.config.ts",
  "drizzle.config.js",
  "drizzle.config.mjs",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
]);

const SKIPPED = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__pycache__",
  "venv",
  "fixtures",
  "testdata",
]);

const skipped = (segment: string) => segment.startsWith(".") || SKIPPED.has(segment);

/** The package a known file belongs to: `prisma/schema.prisma` and `config/database.yml` sit one level in. */
const packageOf = (file: string) => {
  const dir = posix.dirname(file);
  const base = posix.basename(file);
  const parent = posix.basename(dir);

  if (
    (base === "schema.prisma" && parent === "prisma") ||
    (base === "database.yml" && parent === "config")
  )
    return posix.dirname(dir);

  return MANIFESTS.has(base) ? dir : undefined;
};

const known = (file: string) =>
  MANIFESTS.has(posix.basename(file)) || /(^|\/)config\/database\.yml$/.test(file);

/** Nested package directories among checkout-relative file paths; the root itself is left out. */
export const packageDirs = (files: Iterable<string>): string[] => {
  const dirs = new Set<string>();

  for (const file of files) {
    if (!known(file)) continue;
    const dir = packageOf(file);

    if (dir === undefined || dir === "." || dir === "") continue;
    const segments = dir.split("/");

    if (segments.length > PACKAGE_DEPTH || segments.some(skipped)) continue;
    dirs.add(dir);
  }

  return [...dirs]
    .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, PACKAGE_LIMIT);
};

/** Tracked and untracked-but-not-ignored files, so ignored trees like `node_modules` never count. */
const gitFiles = async (checkout: string, signal?: AbortSignal) => {
  if (!mayBeInWorkTree(checkout)) return undefined;

  try {
    const options: GitOptions = { timeoutMs: 1500, maxOutputBytes: 32 * 1024 * 1024 };

    if (signal) Object.assign(options, { signal });

    const result = await runGitRaw(
      checkout,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      options
    );

    if (result.code !== 0) return undefined;

    return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
};

/** One directory's files, and the subdirectories the walk may enter (never symlinks). */
const children = async (checkout: string, dir: string, deeper: boolean) => {
  const entries = await readdir(join(checkout, dir), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  const dirs: string[] = [];

  for (const entry of entries) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;

    if (entry.isFile()) files.push(path);
    else if (deeper && entry.isDirectory() && !skipped(entry.name)) dirs.push(path);
  }

  return { files, dirs };
};

/** Without git: a bounded walk that never enters dot, dependency or build directories. */
const walkedFiles = async (checkout: string, signal?: AbortSignal) => {
  const files: string[] = [];
  let queue = [""];
  let visited = 0;

  for (let depth = 0; depth <= PACKAGE_DEPTH + 1 && queue.length > 0; depth++) {
    const next: string[] = [];

    for (const dir of queue) {
      signal?.throwIfAborted();

      if (++visited > 2000) return files;
      const found = await children(checkout, dir, depth <= PACKAGE_DEPTH);
      files.push(...found.files);
      next.push(...found.dirs);
    }

    queue = next;
  }

  return files;
};

/** The checkout's files that aren't gitignored, or a bounded walk's outside git; relative, `/`-separated. */
export const checkoutFiles = async (checkout: string, signal?: AbortSignal) =>
  (await gitFiles(checkout, signal)) ?? (await walkedFiles(checkout, signal));

/** The nested package directories of `checkout`, relative with `/` separators. */
export const findPackages = async (checkout: string, signal?: AbortSignal) =>
  packageDirs(await checkoutFiles(checkout, signal));
