# Daemon lifecycle: builds, install, upgrade

Everything that gets a `polaris` binary onto a Host, keeps it running as a user service, and replaces it in place. Decisions: ENG-179 and ENG-181.

| File | What |
|---|---|
| `platform.ts` | `VERSION`: the version `scripts/build-daemon.ts` compiled in (`process.env.POLARIS_BUILD_VERSION`, replaced by a constant), else `apps/daemon/package.json`'s when run from source; a dev build is `<version>-dev.<commit count>.<sha>` (with `.dirty<seconds>` from an uncommitted tree), a `--release` build the package version as it is; the three shipped platforms, `polaris version` output and its parser. |
| `templates.ts` | Pure launchd plist and systemd `--user` unit renderers. |
| `install.ts` | `install` / `uninstall` / `stageBinary` / `pointCurrentAt`. |
| `bundle.ts` | macOS: the Daemon's app bundle (`PolarisDaemon.app`, `dev.lux.polaris.daemon`), its `Info.plist`, where each of its files lives, and finding them beside an upload or inside a bundle (ADR 0094). |
| `computerUse/` | macOS: the helper app `Polaris Computer Use.app` that holds computer use's privacy grants, its launcher, and `ComputerUseHelper`, the one way to run a process inside it (ADR 0104). See **Computer use helper** below. |
| `current.ts` | `bin/current`: a relative symlink, or on Windows a directory junction; `readCurrent`, `pointCurrent`. |
| `windowsTask.ts` | Windows: the scheduled task's name, its supervisor loop and its XML, and reading one back: `describeTask` (whose it is, what it runs, its home) and `claimTask` (pure). |
| `windowsProfile.ts` | Windows: the real profile directory from the process token, which the task name follows. |
| `windowsService.ts` | Windows: `planWindowsTask` (pure), registering and running the task, stopping the Daemon. |
| `windowsControl.ts` | Windows: the Daemon's control pipe (`status`, `stop`) and the client that asks it. |
| `daemonStop.ts` | Why the last Daemon stopped on request, for `HostInfo.previousStop`. |
| `launchd.ts` | The macOS service step: `planLaunchd` (pure), `classifyBootstrap`, `activateLaunchd` with its rollback, `unloadEverywhere`. |
| `errors.ts` | `InstallError`. |
| `CommandRunner.ts` | Service for running `launchctl`, `systemctl`, `loginctl` and `<binary> version`; tests replace it. |
| `libc.ts` | `bun:ffi` bindings: `execve`, close-on-exec, `poll`/`accept`, `socketpair`, `waitpid`. |
| `upgrade.ts` | The execve hand-off: `prepareHandoff`, `execInto`, `adoptListener`, `bindAtomically`, `serveUpgrades`, `requestUpgrade`. |
| `selftest.ts` | `polaris selftest`: checks that the embedded fff library loads and searches on this Host, and that the Rules' ast-grep and Betterleaks work (`rules/selftest.ts`). |
| `cli.ts` | The `install`, `uninstall` and `upgrade` subcommands wired into `main.ts`. |

## Builds

`bun run build` (the turbo `build` task of `@polaris/daemon`, via `scripts/build-daemon.ts`) writes a dev build; `bun scripts/build-daemon.ts --release` a release (the package version, unchanged). Each Client upgrades a Host from one dev build to any other (`@polaris/client/install`, `upgradeDue`). It writes:

```
apps/daemon/dist/manifest.json            version, commit, fff/ast-grep/Betterleaks versions, SHA-256 and size per file
apps/daemon/dist/<platform>/polaris       bun build --compile --target=bun-<platform>, self-contained
apps/daemon/dist/<platform>/betterleaks   the Rules' secrets scanner, pinned and checksum-verified (`executable` in the manifest)
apps/daemon/dist/darwin-arm64/PolarisDaemon.app/Contents/{MacOS/polaris,MacOS/betterleaks,Info.plist,Resources/Polaris.icns,_CodeSignature/CodeResources}
apps/daemon/dist/darwin-arm64/Polaris Computer Use.app/Contents/{MacOS/polaris-computer-use,MacOS/agent-desktop,MacOS/agent-desktop-macos-helper,Info.plist,Resources/Polaris.icns,_CodeSignature/CodeResources}
```

**macOS builds are an app bundle** (ADR 0094), so System Settings shows "Polaris" and its icon for the Daemon's permission prompts and Login Items rather than a bare executable. `PolarisDaemon.app` is `dev.lux.polaris.daemon`, `LSUIElement` and `LSBackgroundOnly`, with Betterleaks in `Contents/MacOS`; the build signs the whole bundle ad hoc (`--deep --strict` must verify) and the release signer re-signs it with Developer ID. There is no flat `darwin-arm64/polaris`: the manifest gives each file's `path` inside the platform directory, and archives and uploads carry the five files flat, byte for byte, so the signature survives. Linux and Windows builds are unchanged.

for `darwin-arm64`, `linux-x64` and `linux-arm64` (glibc), `linux-x64-musl` and `linux-arm64-musl` (musl, for Alpine), and `windows-x64` (the binary is `polaris.exe`). The build runs `polaris selftest` on the host platform's binary. CI runs it on each glibc Linux binary on native runners (not yet on the musl ones), and on the Windows binary (`smoke-windows`).

**Windows (0.2.0, x64 only).** The build ships fff (`win32-x64`) and ast-grep (`win32-x64-msvc`, grammars from `prebuild-Windows-X64`) and no Betterleaks (none pinned until ENG-296); `selftest` prints `rules: ok (ast-grep, no betterleaks for windows-x64)`. The home is `%USERPROFILE%\.polaris` (`POLARIS_HOME` overrides it) and the Daemon listens on a user-only named pipe (ADR 0059). Language servers, terminals, Harnesses and live upgrades are unavailable there for now: Language RPCs fail with `unsupported-platform` and aren't announced, and an upgrade stops the Daemon and starts the new one (**Windows** below). In a compiled Windows binary the embedded files live under `B:\~BUN\root\` (`isEmbeddedPath`).

On Linux the platform names the libc: a musl process reports `linux-<arch>-musl` (`runtimePlatform()`, from `src/platform/`: the compiled `POLARIS_LIBC` define, or from source glibc's loader first, then musl's), which is what `polaris version` prints and `polaris upgrade` checks. Bun's musl runtime links `libstdc++.so.6` and `libgcc_s.so.1` dynamically, so an Alpine Host needs `apk add libstdc++ libgcc` (root); the Client's probe checks for them. `HostInfo.platform` (protocol) still says `linux-x64` / `linux-arm64`; `HostInfo.libc` (optional, absent from older Daemons) says `glibc` or `musl`.

- **darwin needs re-signing.** Bun 1.3.13 appends the bundle after linking, which leaves the linker's ad-hoc signature invalid, and this macOS SIGKILLs the binary on exec (exit 137). The build runs `codesign --force --sign -`, so darwin builds must run on macOS (CI does).
- **fff's native library is embedded.** The files workstream uses `@ff-labs/fff-bun` (bun:ffi). It imports `@ff-labs/fff-bin-<platform>/libfff_c.*` with `{ type: "file" }`, so `--compile` embeds the library and loads it from `$bunfs`; no file ships beside the binary. That needs two things at build time:
  1. The **target's** `@ff-labs/fff-bin-*` package installed. Optional dependencies for other platforms are not installed by default, and the bundler then fails with "Could not resolve". When one is missing, the build runs `bun install --frozen-lockfile --os=* --cpu=*`, which installs every platform's optional packages from the lockfile without changing it.
  2. `--define FFF_LIBC="gnu"` (or `"musl"`) for the Linux targets, or fff falls back to git grep at runtime. fff ships `fff-bin-linux-{x64,arm64}-musl`.

  Verified: the darwin binary copied outside the repo (no `node_modules` nearby), the linux-arm64 binary in a Debian container, and the linux-arm64-musl binary in Alpine 3.24 (with `libstdc++ libgcc`) all print `fff: ok` from `polaris selftest`. `POLARIS_FFF=off polaris selftest` exits 1.
- **The Rules' ast-grep is embedded the same way** (`@ast-grep/napi-<platform>`, an optional dependency of the Daemon, plus the `@ast-grep/lang-*` grammars), with `--define process.env.POLARIS_LIBC="gnu"|"musl"` choosing one addon per Linux build. **Betterleaks is not**: it is a Go binary, downloaded at its pinned version, checked against its SHA-256 and placed beside `polaris` (`src/rules/README.md`). `polaris install` and `polaris upgrade` stage it next to the installed binary with mode 755 (`SIBLING_EXECUTABLES` in `install.ts`). `polaris selftest` prints `rules: ok (ast-grep, betterleaks <version>)`; verified on darwin-arm64, Debian 13 arm64 and Alpine 3.22 arm64. The x64 binaries could not be run here: Bun itself crashes under Rosetta (no AVX); Betterleaks' x64 binary runs there.

### Computer use helper (macOS, ADR 0104)

`Polaris Computer Use.app` is a second bundle beside `PolarisDaemon.app`, in the build and in `~/.polaris/bin/<version>/`. System Settings shows the folder's name, and the app holds the Accessibility and Screen Recording grants for computer use, so a grant never covers the Daemon's other children.

- **What is in it.** `Contents/MacOS/polaris-computer-use`, the launcher compiled from `computerUse/launcher.c` with clang (so darwin builds need the Xcode command line tools), and the pinned agent-desktop with its `agent-desktop-macos-helper` (`install/agentDesktop/pin.ts`), downloaded and checksum-verified at build time. The launcher links Security and CoreFoundation. The build runs the bundle's `agent-desktop version` directly, since the launcher serves only the Daemon.
- **Bundle ids.** A release build is `dev.lux.polaris.computer-use`; every other build is `dev.lux.polaris.computer-use.dev`, so dev and release never share a TCC row. The build signs it ad hoc; the release signer (`tooling/release/sign.py`) signs its tools and then the bundle with Developer ID, the hardened runtime and `entitlements/computer-use.plist`, and refuses a build without it. A dev helper's `Info.plist` names no dev version, so its cdhash, which an ad hoc grant is keyed to, stays the same from one dev build to the next until the launcher, the pin or the package version changes.
- **Shipping.** Its six files travel flat like the Daemon's (`polaris-computer-use`, `agent-desktop`, `agent-desktop-macos-helper`, `computer-use-Info.plist`, `computer-use-Polaris.icns`, `computer-use-CodeResources`, each with its `path` in the manifest), and `polaris install` and `polaris upgrade` put them back byte for byte (`stageHelper`). A build without them installs as before.
- **Running a tool in it.** `ComputerUseHelper.spawn({ tool: "agent-desktop", args })` (`computerUse/index.ts`) returns the tool's stdin, stdout, stderr and exit, scoped: closing the scope kills it. `ComputerUseHelper.permissions` runs `agent-desktop status` there and answers `ready` or `needs setup` with the grants missing. Stdio is a socket, not a pipe. It finds the helper beside the Daemon's own bundle; a Daemon run from source has none and fails with `ComputerUseUnavailable`.
- **The hand-off.** Both ways of starting the launcher end the same way (`channel.ts`, `handOff.ts`). The Daemon names a fresh Mach service (`dev.lux.polaris.computer-use.<random>`) and starts the launcher to serve it. The launcher checks the service in; the Daemon looks it up and sends one Mach message carrying three sockets as fileports (`socketpair`, close-on-exec on the Daemon's side): control, data (the tool's stdin and stdout) and stderr. The launcher answers `ok` on control and reads the request there as NUL-terminated records (`a` argument, `v` variable, `w` directory, `.` end); later a `t` or `k` stops the tool, and the launcher answers `exit <code>`. The tool gets its stdio and no other descriptor. If the Daemon goes away, control closes and the launcher stops the tool.
- **Only the Daemon is served** (ENG-867). The kernel stamps a Mach message with its sender's audit token as it is sent, and the launcher takes that token from the message trailer and checks the process's code signature with `SecCodeCheckValidity` before it touches the sockets. Anything else exits 77 (`EXIT_REFUSED`) and `spawn` fails with `ComputerUseUnavailable`. Nothing the caller says about itself is used, and a caller that sends the message and then execs the Daemon's binary is refused, because the token names the program that sent.
  - A launcher signed by a team (a release) asks for `identifier "dev.lux.polaris.daemon"` signed with Developer ID by that same team, the Daemon's designated requirement. The team comes from the launcher's own signature, so it is not written anywhere.
  - A launcher signed ad hoc (every dev build, and a build before the release signer) asks for the designated requirement of the `PolarisDaemon.app` beside its own bundle, which for an ad hoc Daemon is its cdhash. A dev helper therefore serves the dev Daemon it was built or installed with and no other program. This is as far as a dev build goes: an ad hoc helper has no hardened runtime, and a copy of it placed beside another program would serve that program.
  - A Unix socket's peer token (`LOCAL_PEERTOKEN`) is not used. Measured on macOS 27.0, it names whichever process last used the peer socket and follows that process through `exec`, so a program could listen, leave a child to answer, and exec the Daemon's binary to pass.
- **Disclaimed (default).** The Daemon starts `polaris-computer-use run <service>`. The launcher replaces itself with a copy whose responsibility is disclaimed (`posix_spawn` with `POSIX_SPAWN_SETEXEC` and `responsibility_spawnattrs_setdisclaim`, private SPI), then serves, runs the tool as its child and forwards signals. tccd then names the helper as the responsible process and the tool as the accessing one. The launcher stays the parent on purpose: only the bundle's main executable carries the bundle's identity. It runs only a plain file name beside itself, and exits 70 when macOS has no disclaim.
- **LaunchServices (fallback).** With `POLARIS_COMPUTER_USE_SPAWN=launch-services` in the Daemon's environment (or `via` on one request), the Daemon runs `open -n -g -j -a <helper> --args connect <service>`. LaunchServices makes the helper its own responsible process with no SPI. The Daemon must be able to look up a service the helper checks in; that was tried with both in the user's `gui/<uid>` launchd domain, not with a Daemon in `user/<uid>`.
- **What the check does not cover.**
  - A release Daemon's Bun runtime is sealed, so `BUN_BE_BUN=1 polaris script.ts`, `BUN_OPTIONS` and `BUN_INSPECT` no longer run foreign JavaScript inside the signed binary (ENG-875, ADR 0105, `sealedRuntime.ts`). A dev build is not sealed.
  - A native library planted in the temp directory still runs inside the signed Daemon (ENG-877).
  - The Daemon does not check who received its sockets. A program that takes the service name first gets the Daemon's request and can answer as the tool; it gains no grant.

Verified on macOS 27.0 (26A428), arm64, from a child of the release Daemon: with either path, tccd logs `responsible={identifier=dev.lux.polaris.computer-use.dev …}` and `accessing={agent-desktop}`, and names the helper as the attributed bundle; without the disclaim the same child is charged to the Daemon. With no grant, `permissions` answers `needs setup` and a `snapshot` fails with `PERM_DENIED`, though the Daemon itself is granted. After the dev helper was dragged into Device Control and Data Access once, `permissions` answered `ready` and a headless `type` into a TextEdit document was `delivered_verified` on both paths, with Polaris still frontmost.

Verified for ENG-867 on the same macOS with a dev build (`bun scripts/build-daemon.ts darwin-arm64`): the built Daemon binary ran `agent-desktop version` in the built helper on both paths, the second through the real `open`, and the same script run by `bun` was refused. A launcher compiled with the release team forced accepted the installed Developer ID Daemon (0.8.5) and refused `bun` and an ad hoc binary signed as `dev.lux.polaris.daemon`. A program that sent the message and then exec'd the Daemon's program was refused. Not verified: a launcher that is itself Developer ID signed (ENG-868), and the helper's TCC grants after this change; the launcher's cdhash changed, so an ad hoc dev grant must be given again (`tccutil reset Accessibility dev.lux.polaris.computer-use.dev`, likewise `ScreenCapture`).

## Install (`polaris install`)

No sudo; everything under `~/.polaris/` (`POLARIS_HOME`). Each step is idempotent: a second run with the same binary changes nothing and restarts nothing.

1. Copy the binary to `~/.polaris/bin/<version>/polaris`: write a temp file, then rename. It is skipped if the SHA-256 already matches. Renaming matters on macOS: overwriting a signed binary in place gets it killed. On macOS, when the source has the bundle's `Info.plist` and `CodeResources` beside it (an upload) or is inside a bundle, every file goes back to its place in `<version>/PolarisDaemon.app` and `<version>/polaris` becomes a relative symlink to `Contents/MacOS/polaris`; a source without them (an older build) installs flat as before, and a flat version that later arrives as a bundle is replaced by it.
2. Point `~/.polaris/bin/current` at `<version>` with an atomic symlink rename. The service always runs `~/.polaris/bin/current/polaris serve`.
3. Write the service file only if its content changed:
   - macOS: `~/Library/LaunchAgents/dev.lux.polaris.plist`, with `RunAtLoad`, `KeepAlive` and `AssociatedBundleIdentifiers` (the Desktop App's `dev.lux.polaris`, so Login Items lists the agent under it when both are signed by the same team), logs at `~/.polaris/logs/daemon.{out,err}.log`, and `POLARIS_HOME` and `PATH` set (a different `PATH` from the caller changes the file). See **launchd** below.
   - Linux: `~/.config/systemd/user/polaris.service` (`$XDG_CONFIG_HOME` honoured), with `Restart=always`. Then `daemon-reload`, `enable` and `start` (or `restart` if the binary or unit changed while it was running), then `loginctl enable-linger $USER`. If polkit refuses linger (common over SSH), the report says `linger: "needs-admin"` and gives the exact `sudo loginctl enable-linger <user>` for an administrator to run. The Daemon still runs, but it stops at logout.
   - Linux **without a systemd user bus** (`systemctl --user show-environment` fails: minimal containers, SSH sessions without `pam_systemd`, non-systemd distributions): Polaris' own **fallback supervisor**, decided by `planLinuxService` (pure, unit-tested). `~/.polaris/bin/polaris-supervise` (a POSIX sh script, `supervisorScript` in `templates.ts`) detaches itself (`setsid`, else `nohup`), keeps one instance through `~/.polaris/supervisor.pid`, runs `polaris serve`, restarts it when it exits (1 s backoff doubling to 60 s, reset after a minute up), and stops quietly when the Daemon exits 75 (another Daemon holds the lock) or the binary is gone. It comes back after a reboot through a `@reboot` crontab line when `crontab -l` works, and at login through a line in `~/.profile` (and `~/.bash_profile` / `~/.bash_login` when they exist); both lines end with `# polaris-supervisor`. Installing a new binary SIGTERMs the running Daemon and the supervisor restarts it on `current`. The report says `supervisor: "fallback"`, `autostart: ["cron", "profile"]` (or just `["profile"]`), `serviceDomain: "polaris-supervisor"`, and explains itself in `notes`. `polaris uninstall` stops the supervisor and its Daemon and removes both lines (keeping the rest of the crontab and profile). Verified end to end in Debian 13 (glibc, no cron) and Alpine 3.24 (musl, busybox cron): install, `kill -9` of the Daemon (restarted within a second), idempotent reinstall (still one supervisor), uninstall.
4. `polaris install --json` prints the report as one JSON line for the Client, including `supervisor` (`launchd`, `systemd` or `fallback`) and `autostart`.

### launchd

`planLaunchd` (pure, unit-tested) decides from where the label is loaded (`launchctl print gui/<uid>/<label>`, then `user/<uid>/…`) and what changed:

| Loaded in | Service file | Binary | Action |
|---|---|---|---|
| a domain | unchanged | unchanged / new | `kickstart` / `kickstart -k`, in that domain |
| a domain | changed | either | **reload in that domain**: `bootout`, wait until `print` no longer finds the label (up to 30 s; the Daemon shuts down gracefully), `bootstrap`, `enable`, `kickstart` |
| nowhere | either | either | `bootstrap` into `gui/<uid>` if that domain exists (`launchctl print gui/<uid>`), else `user/<uid>` with a note |

Traps (`classifyBootstrap`):
- `launchctl bootout` returns before the job has exited. A `bootstrap` meanwhile fails with **5 (Input/output error)**, the same answer as "already loaded", in *either* domain. 5 is retried after waiting, never read as "no GUI session".
- A missing or unusable domain is 112 ("Could not find domain"), 113 or 125 ("Domain does not support specified action"). Only that, or a 5 for a label loaded nowhere, falls back from `gui/` to `user/`.

**Rollback:** `install` reads the previous `current` target and service file first. If any launchd step fails, it puts both back, boots the label out of every domain, bootstraps the previous definition into the domain it was loaded in and starts it, then fails with the original error plus "the previous Daemon runs again in gui/501" (or "rollback failed too: …"). A service that was not loaded before is left unloaded.

`uninstall` boots the label out of both domains and waits for the job to exit.

Tests: `launchd.test.ts` (the planner, the classifier, and activation against a simulated launchd whose booted-out job lingers) and `launchd.e2e.test.ts`. The latter runs against the real launchd with a temp home and the label `dev.lux.polaris.e2e-<pid>`, never `dev.lux.polaris`: `POLARIS_LAUNCHD_E2E=1 bun test src/service/launchd.e2e.test.ts`. It covers a first load, a reload over a running service whose stand-in Daemon takes 2 s to stop, and a rollback after an injected bootstrap failure.

`polaris uninstall [--purge]` stops and removes the service and `~/.polaris/bin`, stops the shared Codex app-server (which otherwise outlives the Daemon), and keeps the event store and logs unless `--purge` is passed.

A real install on your machine is only done by hand: `POLARIS_MANUAL_INSTALL=1 bun scripts/manual-install.ts [--uninstall]`.

### Windows: a logon task (ADR 0060)

No administrator, ever. `polaris install` copies `polaris.exe` to `%USERPROFILE%\.polaris\bin\<version>\`, points the **junction** `bin\current` at it (a symlink needs a privilege; `current.ts`), writes the task definition to `~/.polaris/polaris-task.xml` and registers it with `schtasks /Create /XML` as `dev.lux.polaris.<user>`. That plain name belongs to `<real profile>\.polaris` only, the profile read from the process token (`windowsProfile.ts`), never from `USERPROFILE`; any other home, a redirected profile's included, adds a hash of its path, so a test, a dev Daemon or the Desktop App's dev mode leaves the real task alone (ENG-322). The task starts at the user's logon, unelevated, with no time or battery limits, and runs `conhost --headless cmd /c <loop>`: the headless console means no window opens, and the loop (`supervisorLoop`) runs `bin\current\polaris.exe serve --home .` in the Polaris home with its output in `logs\daemon.{out,err}.log`, restarting it a second after it exits. It ends on exit 75 (another Daemon), 76 (`SERVE_EXIT_STOPPED`, stopped on request) or when `bin\current\polaris.exe` is gone. Task Scheduler's own restart can't do this: conhost always exits 0.

**A task is replaced only by its own home.** The task's working directory is its home: install reads it back (`schtasks /Query /XML`), `describeTask` decides whether it is this user's Polaris task, and `claimTask` decides. A task has a home only when its principal is this user's SID (from the token), its one action is Polaris' and its working directory is a local drive path; UNC, `\\?\` and device paths are never touched (ENG-333). A task running this home with the action `taskXml` writes is replaced as usual (a 0.2.0-dev install's plain-named task included), and one running an older Polaris loop is `stale` and registered again; another account's task, or one that runs something else, is a conflict with `otherHome: null`, also when Task Scheduler won't let this user read it (`E_ACCESSDENIED` from its COM API, asked only when `schtasks /Query` fails); one whose home has no `bin\current\polaris.exe` left is replaced with a note; one running another installed home, or that isn't Polaris', is left alone and install fails with `TaskConflictError`, **exit 3**, and with `--json` `{"ok":false,"error":"TaskConflictError","message":…,"task":…,"otherHome":…}`. `polaris install --replace-task` (or `upgrade … --replace-task`) takes it over. It stops that home's Daemon first only while the task is running (`taskRunning`: Task Scheduler's COM state, a number where `schtasks /Query` prints a localized word), since then its loop would block ours; a Daemon of that home started any other way is left running, and when the state can't be read it stops it as before (ENG-325). The Desktop App and the SSH installer read the conflict as the typed `TaskConflict` and offer the take-over, confirmed, with `--replace-task` (`apps/desktop/src/main/machines/README.md`). `uninstall` deletes the task only when it runs its home; otherwise it reports `keptTask`.

Install then asks the Daemon over its **control pipe** (`<pipe>-control`, user-only and local-only like the main one; `windowsControl.ts`). `planWindowsTask` decides: a Daemon of another version, a new binary or a new task definition is stopped (it exits 76, so the old loop ends) and the task is run with `schtasks /Run` until the new version answers; the same binary and definition change nothing. The report says `supervisor: "task-scheduler"` and `serviceDomain: "task-scheduler <task>"`.

The task runs only while the user is signed in: with nobody signed in, install fails saying so. `polaris bridge` runs the task when no Daemon answers. `polaris uninstall` stops the Daemon (`uninstall`), deletes the task, moves its own running binary to the temp directory (a running executable can be renamed, not deleted) and removes `bin`. Over SSH a Client stages, uploads and runs these from PowerShell, and the bridge runs behind a PowerShell relay (`bridge --relay <pid>`, ADR 0063).

The end-to-end check runs on a real Host from a Mac: `bun apps/daemon/scripts/e2e-windows-service.ts --host <alias> --dir <C:\scratch> --bun <C:\…\bun.exe>` (Bun 1.4.4 or later) builds two versions and drives install, a killed Daemon, an upgrade and uninstall with a Client connected throughout; with `--local` in place of `--host` it runs on the Windows machine it is on, as CI's "Windows service end to end" job does. `windowsTask.test.ts` and `windowsControl.test.ts` have Windows-only tests (a real `schtasks` registration, the control pipe).

## Upgrade: the execve hand-off (`polaris upgrade <path>`)

On Windows there is no hand-off: `polaris upgrade` stages the binary, repoints `current` and runs the Windows install above, which stops the Daemon and starts the new one (`action: "restarted"`). Running terminals end; Agent Sessions recover from the event log as after a restart. The new Daemon reports `HostInfo.previousStop` (`reason: "upgrade"`, the old version), from the `daemon-stop.json` the old one wrote, so a Client can say why its terminals ended.

The Client uploads the new build and runs `<uploaded path> upgrade <uploaded path>` over SSH: the new binary stages itself, so a build that changes the layout (a flat macOS install becoming a bundle) needs no help from the old one. The running Daemon still only execs the staged path. That command:

1. validates the new binary (`<path> version` must print this Host's platform);
2. stages it as `~/.polaris/bin/<version>/` and repoints `current`, so a later crash-restart also comes up on the new version;
3. if a Daemon is running (`~/.polaris/daemon.pid` names a live process), writes `~/.polaris/upgrade-request.json` and sends it `SIGUSR2`, then waits for `~/.polaris/upgrade-status.json` to report `done` from the same PID. The Daemon writes its pid file only after installing its `SIGUSR2` handler (the signal's default action would kill it), and the wait fails at once if the Daemon dies. If no Daemon is running, it just (re)starts the service.

The running Daemon (`serveUpgrades`) validates the binary again, collects the fds to keep, clears close-on-exec on them, and `execve`s into the new binary in the same PID. It passes the hand-off in `POLARIS_HANDOFF` (listener fd, named fds, child PIDs, and the version it came from). launchd and systemd see nothing change. SQLite needs nothing special: an exec is like a crash to it, and committed transactions are durable.

### What Bun can and cannot do (proven in `upgrade.slow.test.ts`, on macOS and Linux arm64)

| Question | Answer |
|---|---|
| Get a listener's fd | Yes: `listener.fd` on `Bun.listen` and `node:net` servers (missing from the types; use `listenerFd()`). |
| execve from Bun | Yes, via `bun:ffi` (also inside `bun build --compile` binaries). |
| Clear FD_CLOEXEC | Yes, with `ioctl(fd, FIONCLEX)`. `fcntl(F_SETFD)` is variadic, and on Apple arm64 a fixed-arity FFI binding would pass the argument in the wrong place. |
| Adopt an inherited listener with `Bun.listen({ fd })` / `net.Server#listen({ fd })` | **No**: "Bun does not support listening on a file descriptor". |
| Wrap an inherited or accepted *connected* socket fd | Yes: `Bun.connect({ fd })` (`connectFd()`); `new net.Socket({ fd })` does not work. |
| Keep a Harness child across the exec | Yes: it stays our child (same PID). Its stdio must be a socketpair we created (`socketPair()`), because `Bun.spawn` does not expose its pipe fds. After the exec, re-wrap our end with `connectFd` and reap the child with `reapChild` (the new runtime does not know it). |

Because a listener cannot be adopted, `adoptListener` + `bindAtomically` do this instead. The new image binds a fresh listener at `daemon.sock.<pid>.new` and renames it over `daemon.sock` (atomic). It then `accept`s whatever is queued on the inherited listener, plus anything arriving in a 250 ms grace period, hands each fd to the transport, and closes the old listener. The test hammers the socket through the switch and sees **no refused connection**. A connection the old image accepted just before the exec is closed by the exec, and the Client resumes with `afterSequence` as after any reconnect.

No supervisor fallback is needed. If one ever is (e.g. a platform where exec from a threaded runtime misbehaves), the fallback is a tiny stable process that owns the socket and the Harness socketpairs and passes them to each new Daemon over `SCM_RIGHTS`.

### Interface for the transport workstream

```ts
// startup, inside `polaris serve`
const adopted = yield* adoptListener()                   // null on a cold start
const server = yield* bindAtomically(paths().socket, (tmp) =>
  Effect.sync(() => Bun.listen({ unix: tmp, socket: handlers })))
if (adopted) yield* adopted.drain((fd) => void connectFd(fd, handlers))
yield* serveUpgrades({
  listenerFd: () => listenerFd(server),
  collect: () => Effect.succeed({ fds: { ... }, children: { ... } }),  // Harness socketpairs
  beforeExec: Effect.void,                                            // flush anything pending
})
```

`fixtures/handoff-daemon.ts` is a complete working example. If the transport uses `effect/socket` (built on `node:net`), bind it at the temporary path the same way. Adopted connections must still be wrapped with `Bun.connect({ fd })`.

`takeHandoff` consumes the envelope once. It rejects a different `ownerPid`, closed or close-on-exec descriptors, standard streams, and a listener that is not a listening socket. Older envelopes without `ownerPid` remain supported, with the same descriptor checks. Invalid envelopes log a warning and become a cold start; they do not acknowledge an Upgrade or close unrelated descriptors. Valid inherited descriptors, including the listener, regain close-on-exec before any child starts.

Every child launch passes an explicit environment through `childEnv` (`service/childEnv.ts`), including Harness probes, detached servers, terminals and auxiliary commands. Bun 1.3.13's default spawn environment retains the original envelope even after deleting it from `process.env`; filtering only at adoption is insufficient. Explicit snapshots and per-session overrides are filtered as well. `POLARIS_HANDOFF` is the only execve envelope variable; `POLARIS_HOME` and ordinary child settings remain available.

A child that runs a repository's own code (a terminal inside a Review Checkout, so Review Run) gets `repositoryEnv` instead: an allowlist with no provider keys, tokens, `SSH_AUTH_SOCK` or `POLARIS_*` (docs/adr/0054-repository-code-gets-an-allowlisted-environment.md).

### Hand-off contributors

A module with fds or children to keep registers a `HandoffContributor` for the life of its scope (`registerHandoffContributor`): `collect` returns named fds and children (merged with `hooks.collect`), `beforeExec` writes any state the new image needs, and `abort` undoes it if the exec fails. The terminals use this to keep PTYs across upgrades (`terminal/README.md`); the engine registers one with no fds whose `beforeExec` is `Engine.prepareForUpgrade`, which closes in-process (Claude) Harnesses per the recovery rule (`store/README.md`). After the exec, `takeHandoff()` returns the same names.

`libc.ts` loads glibc's `libc.so.6`, or in a musl process (`libcPath()` in `src/platform/`) the loader `/lib/ld-musl-<arch>.so.1` (musl's libc; there is no `libc.so.6`). The hand-off tests pass on Alpine arm64.

### Interface for the Harness workstream

The Codex app-server does not use this: it is started detached, not as the Daemon's child, and the new image re-adopts it through its socket (`harness/codex/README.md`, "App-server lifecycle"), so it also survives crashes and service restarts. A Harness child that must survive an upgrade but not a crash would be spawned with `const [ours, theirs] = socketPair(); Bun.spawn(argv, { stdio: [theirs, theirs, "inherit"] }); closeFd(theirs)`. Our end is then used through `connectFd(ours, …)`. `collect` reports `{ fds: { "harness:<sessionId>": ours }, children: { "harness:<sessionId>": pid } }`, and after the exec `takeHandoff()` returns them. A Harness whose protocol state lives in our process (the Claude Agent SDK) cannot be re-attached. Close it before the exec (the Agent Session goes Dormant) and resume it by cursor afterwards.

## Known gaps / TODO

- `daemon.pid` is written by `serveUpgrades`. Reconcile it with the transport's `daemon.lock` (one file could do both).
- Harness fds are named by convention (`harness:<sessionId>`); the Harness registry has to provide `collect`.
- `StandardOutput=append:` in the systemd unit cannot quote paths, so a `POLARIS_HOME` with spaces breaks logging on Linux.
- Fallback supervisor: with no usable crontab (or no cron daemon running at boot), nothing starts the Daemon after a reboot until the user logs in or a Client connects: `polaris bridge` starts `~/.polaris/bin/polaris-supervise` when no Daemon answers (`transport/README.md`, "Bridge").
- Fallback supervisor: a login profile hook only runs for login shells; `ssh host cmd` does not read `~/.profile`.
- The upgrade request is authenticated only by filesystem permissions (the files are mode 0600 under the user's home), which is enough for a per-user Daemon.
- Only macOS arm64 and Linux arm64 were exercised locally. linux-x64 is exercised by CI's smoke job.
