# Client: installing and upgrading the Daemon over SSH

`@polaris/client/install` makes sure a Host runs a Daemon the Client can talk to. A dev Desktop App bundles every platform's Daemon build (`apps/daemon/dist/`, see `apps/daemon/src/service/README.md`). A release app bundles only its own platform's (the Mac's darwin-arm64; none on Windows), and its manifest lists every platform with the files' and the Release archive's SHA-256, so a Host downloads its build and checks it against what shipped in the app ([ADR 0043](../../../../docs/adr/0043-daemon-downloads.md)).

```ts
const builds = loadBuilds(bundledDistDir)
const download = downloadBuild({ cacheDir, clientVersion })
const result = yield* ensureDaemon(alias, builds, { trigger: "user", approvedSha256 }, { download }).pipe(
  Effect.provide(Ssh.layer),
)
```

| File | What |
|---|---|
| `Ssh.ts` | `Ssh` service: one non-interactive command over the system `ssh` (`-T -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ForwardAgent=no -o ConnectTimeout=15 -- <alias>`), with optional stdin streamed from a local file and an `onStdinBytes` callback for actual upload progress. ssh's own failures (exit 255) become `SshError` with a `failure` of `host-key`, `auth`, `unreachable`, `spawn` or `unknown`. `needsAttention` is true for the first two. Remote commands are wrapped in `sh -c '…'`, so the user's login shell does not matter. `Ssh.local(home)` runs the same commands in a local `/bin/sh` with `HOME` set, for the Client's own machine (the Desktop App upgrading this Mac's installed Daemon). |
| `../wsl/install.ts` | `wslInstallLayer(options)`: the same `Ssh` service for a WSL 2 distro on Windows, each command as `wsl.exe --distribution <distro> --exec /bin/sh -c '…'` (the alias is the distro name). A missing distro is `unreachable`, a missing WSL `spawn`. |
| `../access/index.ts` | `HostAccess`: picks one of the three Layers above from a Host's `HostTarget` and hands out a `HostChannel` (its `exec`, its `Ssh` Layer and alias for this flow, `trusted`, the interactive argv). A local channel exists only for an installed home and never on Windows (`HostActionUnsupported`). Callers should take a channel rather than choose a Layer themselves ([ADR 0045](../../../../docs/adr/0045-platform-services.md)). |
| `builds.ts` | `loadBuilds(distDir)` reads `manifest.json` (a file may have a `path` inside its platform directory, as the macOS bundle's do; uploads and archives still carry it by name): each build says whether its files are `bundled` and, for a release, its `archive` (name, SHA-256, size, URL from `DAEMON_DOWNLOAD_URL`). Also `GLIBC_LOADERS`, `platformFromUname` and `compareVersions` (semver precedence: `0.1.0-alpha.1` < `-alpha.2` < `-beta.1` < `-rc.1` < `0.1.0`; a dev build of a version sorts just before it). |
| `plan.ts` | `planInstall(probe, builds, options)` and `deliveryFor(build, probe)`, pure functions; every branch is unit-tested. |
| `remote.ts` | `probeHost`, `applyPlan`, `ensureDaemon`. |
| `apply.ts` | What both installers share: `RemoteInstallError`, `ApplyOptions`/`ApplyResult`, `runPolaris` and the Daemon's JSON report. |
| `../restart/` | Restart daemon: the Host's service manager restarts the Daemon over the same channel ([ADR 0087](../../../../docs/adr/0087-restart-runs-from-the-client-through-the-service-manager.md)). |
| `windows/` | A Windows Host over SSH ([ADR 0063](../../../../docs/adr/0063-windows-ssh-hosts.md)): the PowerShell probe (`probe.ts`), `-EncodedCommand` and base64-line stdin (`powershell.ts`), the staging, upload, install, upgrade and bridge-relay scripts (`scripts.ts`), and `applyWindowsPlan` (`apply.ts`). |
| `archive.ts` | The Release archive format: `packArchive` (deterministic gzipped ustar of plain files, used by packaging) and `unpackArchive` (refuses paths, links and directories). |
| `download.ts` | `downloadBuild({ cacheDir, clientVersion, fetch })`: the Client-side download into `<cacheDir>/<version>/<platform>/`, checked against the manifest; other versions are removed. |

## Flow

1. **Probe** (one round trip): `uname -s`, `uname -m`, the C library on Linux, the download tools, and `~/.polaris/bin/current/polaris version`. glibc wins: a Host with any of `GLIBC_LOADERS` is glibc even with musl's loader installed beside it, as the Daemon itself decides. Only otherwise is it `libc=musl` (when `/lib/ld-musl-*` exists or `ldd --version` says musl), plus a `missing=<lib>` line for each of `libstdc++.so.6` and `libgcc_s.so.1` not found in `/usr/lib` or `/lib`. Tools: `fetch=curl|wget` (curl preferred), `tar=1`, `sha256=1` (`sha256sum` or `shasum`).
2. **Plan**:
   - `Unsupported` / `MissingBuild`: the Host is not a platform we ship, or its build is not bundled. A musl Host maps to `linux-x64-musl` / `linux-arm64-musl`, never to a glibc build (it would not run). A Windows Host maps to `windows-x64` when its DefaultShell is PowerShell, pwsh or cmd; another DefaultShell is `Unsupported` and named.
   - `MissingLibraries` (`EnsureResult` `HostSetupNeeded`, shown as Needs Attention): a musl Host without `libstdc++` / `libgcc`, which Bun's musl runtime links dynamically. Installing them needs root, so the plan carries the exact `command` (`apk add libstdc++ libgcc`) for an administrator; then retry. Verified on Alpine 3.24 arm64: without them the binary fails to load (`Error loading shared library libstdc++.so.6`); with them `polaris selftest` prints `fff: ok`.
   - `UpToDate`, or `InstalledNewer`: the Host is ahead of this Client. A release never downgrades it; capability negotiation decides.
   - `NeedsApproval`: no Daemon yet. It carries the **platform, version and SHA-256** for the one-time approval, shown inline on the Host as Needs Attention. A **background reconnect never installs**, even for an approved SHA (`reason: "background"`).
   - `Install`: no Daemon, the user asked, and this build's SHA-256 is in `approvedSha256`.
   - `Upgrade`: an older Daemon is installed, or (`upgradeDue`) the bundled build is a **dev build** (`0.0.0-dev.<commit count>.<sha>`, from `scripts/build-daemon.ts` without `--release`) and the Host runs any other version, newer-looking or not: a dev Client installs exactly the build it carries. Approval was given at first install, so no new approval is needed, and it may run on a background reconnect. The Desktop App's background check (`backgroundCheckKey`) uses the same rule.
   `Install` and `Upgrade` carry the **delivery** (`deliveryFor`): `Upload` when the build is bundled; `HostFetch` when it isn't and the Host has a downloader, `tar` and a SHA-256 tool; else `ClientFetch`. A build neither bundled nor published (a dev manifest without its files) is `MissingBuild`.
3. **Deliver** into `~/.polaris/upload-<random>/`:
   - `Upload`: every file of the build through ssh stdin (`cat > f.part && chmod && mv`; mode 755 for the binary and files the manifest marks `executable`, such as `betterleaks`, else 644).
   - `HostFetch`: the Host runs `curl -fsSL --proto '=https'` (or `wget -q`) on `<archive url>?client=<version>&via=host`, checks the archive's SHA-256, `tar -xzf`s it and sets the modes. Any failure (no egress, 404 for an unpublished version, a mismatch) removes the directory and falls back to `ClientFetch`; ssh's own failures do not fall back.
   - `ClientFetch`: `ApplyOptions.download` (`downloadBuild`) fetches `<archive url>?client=<version>&via=client` into its cache, checks the archive and every file, and the result uploads like a bundled build. Without `download` the install fails, naming both attempts.

   Then check each file's SHA-256 on the Host (`sha256sum`, or `shasum -a 256` on macOS) against the bundled manifest, and run:
   - Install: `<upload>/polaris install --json`
   - Upgrade: `<upload>/polaris upgrade <upload>/polaris --json` (execve hand-off, same PID; Harnesses keep running). The uploaded binary stages itself, so a new build can change the install layout, as the macOS app bundle did (ADR 0094).

   `applyPlan` accepts `ApplyOptions`: `progress` reports `downloading` (`via: "host"` with no byte count, or `via: "client"` with real bytes), uploading byte counts across all files, then switching after all hashes match. Progress is throttled to 10 updates/s and has no idle timer. The upload directory is removed after a failed upload as well as after a completed install/upgrade. The JSON line the Daemon prints is returned in `applied.report`. Show its `notes` to the user; in particular `supervisor: "fallback"` means the Linux Host has no systemd user bus and the Daemon runs under Polaris' own supervisor, which only returns after a reboot if `autostart` includes `cron`.

## A Windows Host

When the POSIX probe fails, or its `uname` is Git for Windows' (MINGW, MSYS, Cygwin), `probeHost` runs the Windows probe, a `powershell -EncodedCommand` valid in any DefaultShell, and the probe carries `windowsShell`. Every step then speaks PowerShell, never `sh`: Windows PowerShell reads the SSH channel's stdin itself, so a child process never gets binary stdin intact. Anything sent on stdin goes as base64 lines (`stdinLines`, 48 KiB a line) into a scriptblock that decodes each one. The plan carries `windowsShell` and `applyPlan` hands it to `applyWindowsPlan`:

1. Stage `%USERPROFILE%\.polaris\upload-<random>`, created with a DACL for the user only (refused if it exists or is a reparse point).
2. Upload each file (`CreateNew` to `.part`, then rename) and compare its `Get-FileHash` with the manifest. `HostFetch` isn't implemented: a build that isn't bundled is fetched by the Client.
3. Run `polaris.exe install --sha256 … --json` or `…\bin\current\polaris.exe upgrade … --json`, then remove the staging directory.

The connection runs `bridgeCommand(shell)` instead of `polaris bridge`: a PowerShell relay that decodes lines into `polaris.exe bridge --relay <pid>`, whose stdout is the channel's raw. Set `HostTarget.Ssh({ alias, windowsShell })` from the probe; any configured remote command is ignored. Stderr goes through `stripClixml` before a failure is classified.

## Tests

`plan.test.ts` covers the pure decisions. `remote.test.ts` runs the whole flow against a fake `Ssh` that executes each remote command in a local `sh` with `HOME` set to a temporary "Host", so the real probe, upload and SHA-check scripts run. A shell stand-in plays `polaris install/upgrade`. It covers approval gating, install, idempotence, upgrade, a corrupted upload, and ssh failure classification. For release builds a fake `curl` on the "Host"'s PATH serves a packed archive: the Host-side download, a corrupted one falling back to a fake-fetch Client download and upload, a 404 without a fallback, a tampered Client download, the cache, and dev builds never downloading. The probe's libc decision runs against a fake filesystem root (glibc with musl's loader present stays glibc). `archive.test.ts` checks the format against the system `tar`. `windows/windows.test.ts` checks the Windows commands' limits and parsing everywhere, and on Windows runs them as sshd would under `powershell.exe` and `cmd.exe`; `windows/remote.test.ts` covers the probe's fallback and base64 stdin. `apps/daemon/scripts/e2e-windows-ssh.ts` is the end-to-end run against a real Windows Host. No test reaches the network.

## Known gaps / TODO

- Each file is a separate ssh invocation. Use ControlMaster (the connection workstream's multiplexed session) to avoid repeated handshakes.
- Uploads are not resumable; a dropped connection re-uploads from the start.
- musl `linux-x64-musl` is built but was only exercised under x64 emulation, where Bun crashes for lack of AVX (as its glibc build would); a real x64 Alpine Host is untested. Bun's `*-baseline` targets would cover CPUs without AVX.
- CI does not build or selftest the musl binaries yet.
- Windows: no Host-side download, no `windows-arm64`, and cmd/pwsh as DefaultShell were tested only by running the commands as sshd does.
