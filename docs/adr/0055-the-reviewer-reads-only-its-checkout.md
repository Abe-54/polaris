---
status: accepted
fixes: a prompt-injected Reviewer could read files outside its checkout (security audit, 2026-10-15)
---

# The Reviewer reads only its checkout

## Context

The Reviewer's prompt carries untrusted text: the pull request's
description, the repo's review instructions and the diff. Read-only stopped
writes and network, not reads. Claude Code allowed `Read`, `Glob` and
`Grep` by tool name, so any path; Codex ran the legacy `read-only` sandbox,
which reads the whole disk. Anything the Host user can read (`~/.ssh`,
`~/.aws`, `~/.polaris`, other repositories) could reach the model.

## What we do

The boundary is each Harness's own enforcement, mostly its OS sandbox; Polaris
never decides by parsing a path itself. Every round that leaned on Polaris's
own path checks found a new way past them (`~`, `$HOME`, `file:`, `..` after a
link, brace globs), so its hook now only ever refuses, as a second check.

`harness/confinement.ts` works out, per session, what is readable: the
checkout (canonical) and, for a shell, a fixed toolchain (`/bin`, `/sbin`,
`/usr`'s `bin`, `sbin`, `lib*`, `libexec` and `share`, `/lib*`, `/dev`,
`/nix/store`, `/System`, `/private/var/select`, macOS's active developer
directory and the Xcode licence plist, and of `/usr/local` and
`/opt/homebrew` only the program and library dirs: never their `etc` or
`var`, where Homebrew keeps service configs and the user's own database
files), minus anything that is home (the Daemon's or the session's),
Polaris's state or a parent of either. Not the PATH: a PATH directory can be anywhere. A checkout that holds
home can't be confined, and its session doesn't start. Inside what is
readable, `hidden` names what stays closed: the git dir when the checkout is
the repository itself (so it has no git), and the Harnesses' config dirs and
the usual credential paths (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`,
`~/.git-credentials`, `~/.claude*`, `~/.codex`…) wherever a readable root
covers them.

In a linked worktree the shell also reads what git needs of the common dir
(`objects`, `refs`, `packed-refs`, `HEAD`, `reftable`, `shallow`, `info`) and
of the worktree's own git dir (`HEAD`, `index`), never `config` or
`config.worktree`, whose remotes and headers can carry tokens, nor other
worktrees. Git reads a config Polaris builds from an allowlist
(`harness/confinedGit.ts`), never a filtered copy of the repository's: a
denylist misses the next key that runs a program. It holds
`core.repositoryformatversion` and `extensions.objectFormat`,
`compatObjectFormat` and `refStorage`, each only with a value git knows,
`core.bare = false`, `core.worktree` set to the canonical checkout, and ignore
and attributes files set to `/dev/null`; nothing else, so no remotes,
includes, helpers, filters, hooks, `fsmonitor`, proxies or `worktreeConfig`
(which would make git read `config.worktree`). Each session gets a fresh
directory from `mkdtemp` under Polaris's state (`confined-git/`, mode 0700,
refused if it is a link or others can write it), with the config written
there under a temporary name and renamed into place, and links to the shared
parts. It used to live in the worktree's git dir, which anything writing to
the repository could change between Polaris writing it and git reading it.
Git finds it through `GIT_COMMON_DIR`, with `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1` (the system config can name a credential helper
too) and `GIT_CONFIG_COUNT=0`. If it can't be generated, the Reviewer doesn't
start. Directories older than a day are removed when the next one is made. On macOS `DEVELOPER_DIR` names the developer tools, because
`/usr/bin/git` finds them through `/var`, which stays closed.

- **Claude Code**: Claude Code's sandbox covers Bash, not its file tools, so a
  sandboxed Reviewer has only Bash (and Subagents, which inherit it): every
  read goes through Seatbelt or bubblewrap with `denyRead: ["/", …hidden]` and
  `allowRead` for the checkout and the shell roots, no writes, and no network
  (an empty strict allowlist). Claude Code passes its environment to Bash, its
  provider key included; `sandbox.credentials.envVars` unsets in the sandbox
  every variable of the session's environment but the shell basics and the
  confined git's. Not `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`: it also drops
  `GIT_CONFIG_GLOBAL`, so git fails on the closed `~/.gitconfig`, and forces
  the `default` permission mode. Without the sandbox there is no shell, only
  Read, Glob and Grep, kept in by Claude Code itself: `dontAsk` with reads
  allowed only by path (`Read(//<checkout>/**)`),
  `permissions.blockReadsOutsideWorkingDirectories`, and `Read` deny rules
  for the hidden paths. The session's environment is still an allowlist (the
  shell basics, Claude Code's own `ANTHROPIC_*`/`CLAUDE_*`, proxies and
  certificates, a cloud provider's only while Claude Code uses it).
  `additionalDirectories` is empty and there are no MCP servers. Claude
  Code runs in the checkout's canonical path, with the environment the
  confinement was worked out from. Polaris's `PreToolUse` hook sees every
  call, subagents' included, and is default-deny: only the session's tools,
  only the fields each one documents (so no `dangerouslyDisableSandbox`, and
  no `Agent` `isolation`, whose worktree lives in the repository and whose
  remote agent runs in the cloud), and only from a `cwd` inside the checkout.
- **Claude Code on Linux**: its bubblewrap sandbox (verified on 2.1.285)
  ignores `denyWrite: ["/"]` for the working directory and, in a linked
  worktree, binds the repository's whole git dir read-write. So the
  repository's git dirs are also named in `denyWrite`, and its `config`,
  `logs`, `hooks`, `modules`, `FETCH_HEAD` and other worktrees in `hidden`
  (`closedGitPaths`). The checkout itself stays writable there: naming it in
  `denyWrite` makes bubblewrap fail to create its mask files in it.
  `readOnly.e2e.test.ts` drives the installed `claude` through a fake Messages
  API to check all of this, the file tools with Polaris's hook removed.
- **Codex**: the thread runs under a permission profile (`default_permissions`
  in `thread/start`'s config): `:minimal` and the roots readable, the hidden
  paths, `/tmp` and `$TMPDIR` denied, nothing writable, no network. Neither
  `thread/start`'s `sandbox` nor `turn/start`'s `sandboxPolicy` is sent: Codex
  refuses a mode next to a profile, and a Turn's legacy policy would replace
  it for the thread. An app-server older than 0.159.2 (by `initialize`'s
  `userAgent`) could ignore the profile and fall back to the user's own
  sandbox, so the session doesn't start. MCP servers, plugins, apps, hooks and
  browser or computer use run outside the sandbox: Polaris asks `config/read`
  (with the checkout as `cwd`, so project layers count) for the user's servers
  and plugins and turns each off, with those features, memories and web
  search; without that answer the session doesn't start. Commands inherit
  only Codex's `core` variables, so Codex's own key stays out. Verified with
  `codex sandbox` under the profile on codex-cli 0.162.1: git works, the
  repository's config, home and a link out are unreadable, no network.
- **Codex on Linux** (ENG-758): Codex's bubblewrap sandbox starts by running
  Codex's own binary inside it (`/proc/self/exe`, to apply seccomp), and the
  profile starts from an empty root. A binary under home
  (`~/.codex/packages/standalone`, `~/.npm-global`, `~/.local`) was invisible
  there, so every command failed with `bwrap: execvp …/codex: No such file or
  directory`, and the Reviewer still replied. The profile now also reads that
  one file, the shared app-server's binary as `/proc` names it (an npm
  launcher's native child), never its directory, and never inside a hidden
  path. bubblewrap binds just the file, so the directories above it show
  only the path to it. On a system bubblewrap older than 0.9 (no `--argv0`)
  Codex runs its own `argv[0]` instead, which this doesn't cover. Either
  way, when every command the Reviewer ran printed nothing but bubblewrap's,
  Codex's or `sandbox-exec`'s own one-line error and exited as that tool does
  (1; `sandbox-exec` 65 or 71), the sandbox never started, and the Risk
  Summary's agent layer fails with that line. The reviewed change controls its
  scripts' output and can print the same line, so one such command beside a
  command that ran fails nothing, and a failed layer still keeps the Findings
  the Reviewer returned from the diff: mimicking the error can mark the layer
  failed but can't hide a Finding.
- **OpenCode**: unchanged. Its supervised ruleset asks for
  `external_directory`, and the Reviewer's policy denies every ask.
- **ACP agents** read with their own tools, which Polaris can't confine: a
  read-only session is refused, with a line naming the Harnesses that can review.

## Limits

Tests and lint run only with the toolchain in the fixed list: a tool in home
(`~/.bun`, `~/.nvm`, `~/.local/bin`) doesn't run in the sandbox. This is an
open product trade-off, not an oversight: opening a toolchain under home
would open the rest of home's layout around it. Without a writable temp dir,
macOS's `/usr/bin/git` warns on every call that it can't cache. Reads of the
toolchain (Claude Code) or `:minimal` (Codex) stay open. Verified on macOS
(Claude Code 2.1.300, codex-cli 0.162.1) and on a Raspberry Pi with Debian 13
(Claude Code 2.1.285, bubblewrap 0.12.0, a Python stand-in for its socat bridges): git works; home, `/etc`, `~/.ssh`,
`~/.config` and the repository's `config` are unreadable; other processes
don't show in `/proc` (a PID namespace); no network. The Pi has no `rg`, and
Claude Code doesn't put its bundled one in the shell, so a Host without `rg`
installed has no `rg` in the Reviewer's shell.
