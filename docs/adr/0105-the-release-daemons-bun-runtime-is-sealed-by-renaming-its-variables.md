---
status: accepted (ENG-875, ENG-846)
---

# The release Daemon's Bun runtime is sealed by renaming its variables

## Context

The computer use launcher serves only a process signed as the Daemon (ADR 0104, ENG-867). That
check names the binary, not what it runs, and the Daemon is a `bun build --compile` executable:
the whole Bun runtime with the Daemon's program appended. Bun 1.4.4 (read at its commit
38afee6c) reads these from the environment before any of the Daemon's code runs:

- `BUN_BE_BUN=1`: the executable ignores its program and is the `bun` CLI, so
  `BUN_BE_BUN=1 polaris script.ts` runs the script.
- `BUN_OPTIONS`: its flags are parsed as Bun's own. `--preload`, `--require` and `--import` run a
  file before the entry point; `--inspect` opens a debugger.
- `BUN_INSPECT`, `BUN_INSPECT_CONNECT_TO`: a debugger, which evaluates what its client sends.
  `BUN_INSPECT_PRELOAD` is one more preload when flags are parsed.

Each was confirmed on a compiled executable. Any program of the same user could so run its code
under the Daemon's Developer ID signature and pass as the Daemon. Bun has no compile option that
turns them off, and a guard in the Daemon's JavaScript runs too late, or never.

These did not run foreign code: flags on the command line (they are the program's arguments), an
`argv[0]` of `node` or `bunx`, `NODE_OPTIONS`, and `bunfig.toml` or `.env` files (the build
already turns their autoload off).

## Decision

A darwin release build renames the three names inside the compiled executable, before it is
signed: the first five bytes of each become `DYLD_` (`BUN_BE_BUN` is `DYLD_E_BUN`,
`BUN_OPTIONS` is `DYLD_PTIONS`, `BUN_INSPECT…` is `DYLD_NSPECT…`). The length stays, so nothing
moves. Only the runtime is changed, never the Daemon's own program in the `__BUN` segment.
`apps/daemon/src/service/sealedRuntime.ts` does it; `scripts/build-daemon.ts` calls it.

Two facts make this a seal:

1. Bun looks a variable up by the name in its binary (`getenv`), so it no longer reads the old
   names.
2. dyld removes every `DYLD_` variable from the environment of a hardened-runtime process before
   `main`, unless it has the `allow-dyld-environment-variables` entitlement. The release Daemon
   has the hardened runtime and not that entitlement, so nobody can set the new names.

An unsettable name has to come from the system: on macOS any other name can be put in a
process's environment by whoever starts it.

The build fails closed. It refuses to seal unless each name stands exactly as often as in Bun
1.4.4 (1, 2 and 11 times), and on the host platform it then runs the built Daemon once per route
with a script that leaves a marker, and fails if a marker appears or the Daemon waits for a
debugger. `sealedRuntime.slow.test.ts` does the same on real release and dev builds, and checks
the renamed names on a copy signed with the hardened runtime and the release entitlements.

## Considered Options

- **A native main executable that clears the environment and runs Bun.** Rejected: `exec`
  changes the process's code identity to Bun's, and the inner executable can still be started
  directly.
- **A guard library loaded before `main` (`LC_LOAD_DYLIB`).** Rejected while the Daemon has
  `disable-library-validation` (ENG-877): a copy of the executable beside another library of
  that name would load it.
- **Our own Bun, built from source without these routes, given to the compile as
  `compile.executablePath`.** Correct, and independent of dyld, but it puts a Bun source build
  in the release pipeline. This is the way out if the seal stops holding.
- **Signing dev builds with the hardened runtime.** Not done: it needs the JIT entitlements in
  dev signing, and dev builds are already unprotected (ADR 0104).

## Consequences

- When a Bun upgrade changes the counts or adds a route, the build and the test fail. Read the
  runtime again (`src/runtime/cli/mod.rs`, `src/bun_core/env_var.rs`); if a rename no longer
  closes it, build Bun from source as above.
- The seal leans on dyld's pruning. The slow test would catch a macOS that stops doing it, and
  an entitlement that allows `DYLD_` variables, since it signs with the release's own file.
- Only darwin release builds are sealed. A dev build is ad hoc without the hardened runtime: it
  is not sealed, and a sealed build signed that way would read the renamed names. Linux and
  Windows builds are unchanged: nothing there trusts a signature.
- The release Daemon no longer honours `BUN_OPTIONS` or `BUN_INSPECT` itself; they still pass
  through to the processes it starts.
- `BUN_INSPECT_CONNECT_TO` is closed by the same rename but has no run of its own in the checks:
  it connects after a short command has ended.
- Not closed here: a native library planted in the temp directory (ENG-877), and the Desktop
  App's `ELECTRON_RUN_AS_NODE` (ENG-878).
