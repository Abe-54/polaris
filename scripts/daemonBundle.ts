/**
 * How the compiled Daemon is bundled (ENG-752): minified, split into lazily parsed chunks, and
 * with a sourcemap Bun embeds (zstd) and applies to `Error.stack` itself, so a Self-Trace's
 * stack names `apps/daemon/src/…:line:column` rather than `/$bunfs/root/chunk-….js`.
 */
import { rmSync } from "node:fs";

/** Bun.build options every Daemon build shares, beside its entrypoints, target and defines. */
export const DAEMON_BUILD_OPTIONS = {
  minify: true,
  // Lazily imported commands and Harness drivers become separate chunks, parsed only
  // when imported: `serve` never parses the Claude Agent SDK, `bridge` not the Daemon.
  splitting: true,
  sourcemap: "linked",
} as const satisfies Partial<Bun.BuildConfig>;

/**
 * Bun.build with the cwd at `root`: Bun writes sourcemap paths relative to the cwd, so stacks
 * name repo-relative files, never the builder's home. The `.map` copies Bun also writes beside
 * the binary are removed; the binary carries its own.
 */
export const buildFromRoot = async (root: string, config: Bun.BuildConfig) => {
  const previous = process.cwd();
  process.chdir(root);

  try {
    const result = await Bun.build(config);

    for (const { path } of result.outputs) if (path.endsWith(".map")) rmSync(path, { force: true });

    return result;
  } finally {
    process.chdir(previous);
  }
};
