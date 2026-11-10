---
status: accepted (ENG-875, ENG-846); amended (ENG-877)
---

# The release Daemon's Bun runtime is sealed by renaming its variables

## Context

The computer use launcher serves only a process signed as the Daemon (ADR 0107, ENG-867). That
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
  dev signing, and dev builds are already unprotected (ADR 0107).

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
- The Simulator's tools (ADR 0099, ENG-829) ran as `BUN_BE_BUN=1 <polaris>`, which a sealed
  Daemon refuses like any other script. A sealed Daemon runs them with Oven's own release of
  its Bun version instead, downloaded on first Simulator use and checked against a pinned
  sha256 (`apps/daemon/src/install/simulator/runtime.ts`). It keeps Oven's Developer ID
  signature: nothing signed as Polaris runs foreign JavaScript, so the launcher's check of the
  Daemon's identity means what it did. A second runtime shipped in the bundle would have been
  signed by our team, and 60 MB in every download. Other builds are still their own Bun.
- Not closed here: the Desktop App's `ELECTRON_RUN_AS_NODE` (ENG-878). A native library planted
  in the temp directory (ENG-877) is closed by the amendment below.

## Amendment: the Daemon's native libraries ship signed in its bundle (ENG-877)

### Context

The seal covers JavaScript. Native code had its own way in. Bun cannot `dlopen` a library
embedded in a compiled executable, so it writes it to `$BUN_TMPDIR` or `$TMPDIR` as
`.bun-<uid>-<wyhash of the bytes>.<ext>` first, and when a regular file of that name, owner and
size is already there it loads that file without reading it (`resolve_embedded_file_to_buf`,
`src/runtime/jsc_hooks.rs`, called for `process.dlopen` and `bun:ffi`; Bun 1.4.4 at 38afee6c).
The name is computable from the shipped binary and the caller picks the directory. The Daemon
embedded fff's library, ast-grep's addon and libsodium this way, and copied ast-grep's four
grammars to `~/.polaris/lib/grammars/`, where an existing file was used as it was. The release
Daemon was signed with `disable-library-validation` so that those unsigned copies would load,
which made macOS load anybody's. A same-size file planted under the expected name ran its
constructor inside `polaris selftest` on D7's release build.

### Decision

A darwin Daemon embeds no native library, and the release Daemon has library validation.

- The build replaces the import of each of the seven libraries with its path in the bundle
  (`bundleLibrariesPlugin`, `apps/daemon/src/service/bundleLibraries.ts`) and copies the files
  to `PolarisDaemon.app/Contents/Frameworks`. They are bundle files like any other
  (`BUNDLE_FILES`): in the manifest, the archive and what `polaris install` places.
- The release signer signs each file there with the Developer ID before the bundle
  (`tooling/release/sign.py`, mirrored in `apps/desktop/scripts/packaging/manifest.ts`).
- `daemon.plist` no longer has `com.apple.security.cs.disable-library-validation`. macOS then
  maps into the Daemon only libraries signed by Apple or by our team, wherever they are and
  whoever asks: a planted file, a library swapped in a copy of the bundle, a `libsqlite3.dylib`
  put before the system's.

Library validation is the fix; the bundle is what makes it possible. The build fails closed:
it counts Mach-O libraries inside the compiled program (none allowed) and runs `selftest` with
`DYLD_PRINT_LIBRARIES`, failing on any image that is neither macOS's nor one of the seven.
`bundleLibraries.slow.test.ts` plants files on a real release build.

Every native library a darwin Daemon loads:

| Library | From | Loaded by |
|---|---|---|
| `libfff_c.dylib` | the bundle | `bun:ffi` in `@ff-labs/fff-bun` |
| `ast-grep-napi.darwin-arm64.node` | the bundle | `require` in `rules/patterns/native.ts` |
| `tree-sitter-{python,go,rust,bash}.so` | the bundle | ast-grep, by path |
| `sodium-native.node` | the bundle | `require` in the patched `sodium-native` |
| `/usr/lib/libSystem.B.dylib` | macOS | `bun:ffi` (`libcPath()`) |
| `libsqlite3.dylib` | macOS | Bun's `bun:sqlite`, by leaf name |
| system frameworks | macOS | Bun itself (FSEvents, Security, CoreFoundation) |

Nothing else needed the entitlement. JIT code and `bun:ffi`'s trampolines are covered by
`allow-jit` and `allow-unsigned-executable-memory`. Harnesses, Betterleaks, git and language
servers are processes the Daemon starts, validated under their own signatures, not libraries
it loads.

### Considered Options

- **Sign the libraries before they are embedded.** The extracted copy would keep its signature,
  but the build job has no identity (ADR 0057): signing comes after the compile, when the bytes
  are already inside the program.
- **A private, verified extraction directory.** Bun has no setting for it, and checking a file
  and then opening it leaves a gap for a program of the same user, which can write wherever the
  Daemon can.
- **Renaming `BUN_TMPDIR` as the seal does.** `$TMPDIR` remains.

### Consequences

- The darwin `polaris` no longer works alone: it needs its bundle's `Contents/Frameworks`.
  It finds it from its own real path, so a link to the executable still works.
- The signer runs from the default branch: its change must be on main before a release tag
  whose Daemon has these files, or their signatures stay ad hoc and the Daemon loads none.
- A new native dependency must be added to `BUNDLE_LIBRARY_NAMES` and
  `BUNDLE_LIBRARY_SOURCES`; until then the build fails on the embedded library.
- A dev build is ad hoc without the hardened runtime: it has the same layout and no
  protection, as above. An ad hoc build with the hardened runtime loads no library of its own
  (no team to match), so only a Developer ID build shows the signed libraries loading.
- Linux and Windows builds still embed their libraries: nothing there trusts a signature.
