// The sanctioned call sites of the security rules (`index.mjs`), repo-relative.
// Adding an entry is a security review: say where the bytes, the config or the env come from.
// See docs/security/README.md.

/** `security/git-spawn`: where the Daemon may start git (or find it) itself. */
export const GIT_SPAWN = {
  scope: ["apps/daemon/src/"],
  allow: {
    // The one way: safe config unless `config: "host"`, bounded output.
    "apps/daemon/src/git/git.ts": "gate",
    // Finds git's absolute path on PATH, which every spawn above passes (never a bare `git`).
    "apps/daemon/src/git/executable.ts": "gate",
    // Lists the config the safe settings are computed from, with only the fixed settings.
    "apps/daemon/src/git/safeConfig/index.ts": "gate",
    // `git --version`, to know whether GIT_NO_LAZY_FETCH is honoured.
    "apps/daemon/src/git/safeConfig/lazyFetch.ts": "gate",
    // Streams a bounded staged diff; the safe config and safeArgs, as git.ts gives them.
    "apps/daemon/src/commitMessage/staged.ts": "safe",
    // Streams `git grep` hits; the safe config.
    "apps/daemon/src/files/search/fallback.ts": "safe",
    // `cat-file --batch` into a file (memory); the safe config and an allowlisted env.
    "apps/daemon/src/rules/materialize.ts": "safe",
    // Betterleaks runs `git log -p` itself; its env carries the safe config.
    "apps/daemon/src/rules/secrets/betterleaks.ts": "safe",
    // `git commit` the user asked for, with hooks' output streamed: the Host's config.
    "apps/daemon/src/git/write.ts": "host",
  },
};

/** `security/spawn-path`: spawns in a cwd whose program is resolved where the rule can't see. */
export const SPAWN_PATH = {
  scope: ["apps/daemon/src/"],
  allow: {
    // The resolver itself: the one place that calls Bun.which.
    "apps/daemon/src/platform/executable.ts": "resolver",
    // argv[0] goes through programIn (a bare name off PATH) before the macOS gate's /bin/sh.
    "apps/daemon/src/terminal/Terminals.ts": "resolved",
    // shellCommand's argv[0] is /bin/sh, or ComSpec through executableOf.
    "apps/daemon/src/constellation/setup/process.ts": "resolved",
  },
};

/** `security/git-config-mode`: who may pass `config: "host"` or `"trusted-fetch"` to git.ts. */
export const GIT_CONFIG_MODE = {
  scope: ["apps/daemon/src/"],
  allow: {
    // Git the user asked for (ADR 0056): Accept's commit and push.
    "apps/daemon/src/accept/commit.ts": "host",
    "apps/daemon/src/accept/push.ts": "host",
    // A session's Worktree creation (hooks still off); a detached Review one stays safe.
    "apps/daemon/src/git/WorktreeTracker.ts": "host",
    // A Constellation's push to origin.
    "apps/daemon/src/git/constellationBundles.ts": "host",
    // Pull and push from the status bar.
    "apps/daemon/src/git/sync.ts": "host",
    // Stage, unstage, discard and commit.
    "apps/daemon/src/git/write.ts": "host",
    // A Review fetch: trusted-fetch only when the Host trusts the Workspace.
    "apps/daemon/src/git/review/fetch.ts": "trusted-fetch",
    "apps/daemon/src/git/review/remotes.ts": "trusted-fetch",
  },
};

/** `security/image-decode`: where the renderer may hand bytes to a decoder or Mermaid. */
export const IMAGE_DECODE = {
  scope: ["apps/desktop/src/renderer/", "apps/desktop/src/shared/", "packages/ui/src/"],
  allow: {
    // Thumbnails of readStaged's blob, which readHostImage admitted (admitRaster).
    "apps/desktop/src/renderer/features/attachments/previews.ts": "admitted",
    // A file the user picked, pasted or dropped on this Client: not Host bytes.
    "apps/desktop/src/renderer/features/attachments/stage.ts": "local",
    // readStaged's admitted blob as an object URL.
    "apps/desktop/src/renderer/features/attachments/ui/SentAttachments.tsx": "admitted",
    // readHostImage's admitted blob as an object URL.
    "apps/desktop/src/renderer/features/session/ui/ImageViewer.tsx": "admitted",
    // The transcript image pool: object URLs for readHostImage's admitted blobs only.
    "apps/desktop/src/renderer/features/host-images/pool.ts": "admitted",
    // The preview pool: object URLs for media views Main admitted (media.ts, admitRaster).
    "apps/desktop/src/renderer/features/editor/markdown/media.ts": "admitted",
    // Computer use preview frames, which Main admitted (main/ipc/computerUse.ts, admitRaster).
    "apps/desktop/src/renderer/features/session/ui/computerUse/frames.ts": "admitted",
    "apps/desktop/src/renderer/features/session/ui/computerUse/usePreview.ts": "admitted",
    // A Simulator hub's JPEG frames, each through admitRaster before createImageBitmap.
    "apps/desktop/src/renderer/features/simulator/video.ts": "admitted",
    // Loads Mermaid only to wrap it in guardedDiagrams (diagrams.ts).
    "apps/desktop/src/renderer/features/session/ui/markdown/plugins.ts": "guarded",
    // Dev evidence pages on a fake Host: they count object URLs, never ship.
    "apps/desktop/src/renderer/features/editor/markdown/evidence.tsx": "evidence",
    "apps/desktop/src/renderer/features/editor/markdown/editor-evidence.tsx": "evidence",
  },
};

/** `security/repository-env`: modules that start children running a repository's code. */
export const REPOSITORY_ENV = {
  scope: [
    // Worktree setup: a lockfile's install scripts.
    "apps/daemon/src/constellation/setup/",
    // The Reviewer's environment, shell and git.
    "apps/daemon/src/harness/claude/readOnly.ts",
    "apps/daemon/src/harness/confinement.ts",
    "apps/daemon/src/harness/confinedGit.ts",
    "apps/daemon/src/harness/codex/confinement.ts",
    // Which terminals get the repository environment (a Review Checkout's).
    "apps/daemon/src/terminal/environment.ts",
    // git and Betterleaks over a pull request's commits.
    "apps/daemon/src/rules/materialize.ts",
    "apps/daemon/src/rules/secrets/betterleaks.ts",
  ],
  // The allowlisted environments; process.env may reach a child only through one of them.
  builders: ["repositoryEnv", "setupEnv", "readOnlyEnv"],
  allow: {},
};
