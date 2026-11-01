# Installer build

`bun run --cwd apps/desktop package --release` produces both
`out/dist/Polaris-<version>-arm64-mac.zip` and
`out/dist/Polaris-<version>-arm64.dmg`. To rebuild just the DMG from the existing
`out/dist/Polaris-darwin-arm64/Polaris.app`, run
`bun apps/desktop/scripts/dmg.ts` from the repository root.

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) on the macOS
runner before packaging. `uv run --locked --script build_dmg.py` uses the committed
script lockfile, including wheel hashes. It needs Python 3.10 or newer, macOS's
`hdiutil`, `tiffutil`, and the Xcode Command Line Tools (`SetFile`). The build
writes `.DS_Store` directly with [dmgbuild](https://dmgbuild.readthedocs.io/en/latest/);
it needs no Finder, AppleScript, display, or logged-in GUI session.

Build-only dependency audit: dmgbuild 1.6.7, ds-store 1.3.3 and mac-alias 2.2.3
are all MIT licensed (verified from their installed licence files). None is
bundled into Polaris, and no upstream implementation is copied. The repository's
`bun run licenses:check` audits shipped JavaScript/native dependencies separately.

The background comes from DESIGN.md's accepted Installer recipe:
`uv run --with numpy --with pillow design/scripts/gen_dmg.py`. The committed
`design/assets/dmg/background.png` and `background@2x.png` share whole-pixel
330×200 scene cells. dmgbuild combines them with `tiffutil -cathidpicheck` into the
hidden Retina TIFF on the image. The HFS+ image uses UDZO/zlib compression and
contains the app, an Applications symlink, the app's volume icon, and Finder's
660×400 layout with the specified 100pt icons and 12pt labels.

Finder's saved window bounds include its 32pt title bar, so the image specifies
660×432 window bounds for 660×400 content. A fresh image honours the toolbar and
sidebar settings. Navigating to an already mounted volume from an existing
window can retain that window's chrome. Finder's global path/status bar settings
may override the image's preferences; "Show all filename extensions" exposes
`Polaris.app` despite its hidden-extension flag. These are native Finder limits.

Real mounted verification on macOS 27.0 found black icon labels on the night image
even with dark Finder chrome; Paper I1 had assumed white labels in dark appearance.
The user chose the dawn background (Paper I3/I4) for everyone after this finding.
The generator now draws that scene with seed 12, meadow flowers and the dawn
cabin, with a neutral ink arrow. The black labels are legible in both Finder
appearances. No label colour is baked into the background; Finder draws the labels.

Packaging with credentials is for a local signed build; the release workflow never
gives packaging credentials. It packages unsigned and signs the outputs with
`tooling/release/sign.py` in separate jobs ([ADR 0057](../../../../docs/adr/0057-release-signing-runs-apart-from-the-build.md)).

With the same complete credentials consumed by `release.ts`, packaging verifies
the already signed and stapled app, builds the image without modifying it, signs
the DMG with Developer ID and a secure timestamp, waits for `notarytool` to return
`Accepted`, staples and validates the DMG ticket, then verifies the image checksum.
Only then is the staged DMG moved to its stable output name. Failures clean the
staging directory and leave any previous verified output intact. Without
credentials the image is built and checksum-verified unsigned; partial credentials
fail before building. Real Apple-service validation awaits ENG-253 credentials.

## Daemon downloads

A release app bundles only the Daemon its machine runs ([ADR 0043](../../../../docs/adr/0043-daemon-downloads.md)).
With `--release`, after the darwin-arm64 build is signed, `archives.ts` writes
`apps/daemon/dist/release/polaris-daemon-<version>-<platform>.tar.gz` for all five
platforms (a deterministic gzipped ustar of `polaris` and `betterleaks`, with their
modes; on macOS the Daemon's app bundle files too, flat, read from their manifest `path`, ADR 0094) and `polaris-daemon-<version>-SHA256SUMS`, and records in `manifest.json`
each archive's name, SHA-256 and size plus the download URL template
(`https://polaris.lux.dev/api/daemon/{version}/{platform}`). Each target then gets
its own staged `Resources/daemon` (`stageDaemon`): the Mac only `darwin-arm64/`,
Windows no platform directory, both with the full manifest and
`bundled: [<platforms present>]`. Packaging checks that every platform is still
downloadable from the staged manifest and that the bundled files match it.
The `release/` directory never enters an app; the release workflow uploads it with
the DMG and ZIP, and leaves it out of the dist artifact the Windows job reuses.

Without `--release` (and in `dev`) nothing changes: every platform is bundled and the
manifest has no archives, since no Release exists to download from.

Measured on 0.1.0-alpha.2, unsigned: `Polaris.app` 423 MB (was 980 MB),
`Resources/daemon` 101 MB (was 657 MB), DMG 174 MB (was about 390 MB), update ZIP
174 MB. The five archives are 37 MB (darwin-arm64) to 56 MB (linux-x64).

## Windows (experimental, unsigned)

`bun run --cwd apps/desktop package --windows --reuse-daemon` builds win32 x64
and arm64 with the existing pixel icon and Windows executable metadata, then
runs `electron-winstaller` 5.4.4 (MIT) for each. Installer generation needs
Windows, or both Mono and Wine on macOS/Linux. `--no-installer` allows local
cross-builds without those tools. Regenerate `Polaris.ico` with
`bun apps/desktop/scripts/packaging/icon.ts`: its six PNG entries (16, 32, 48,
64, 128, 256) are the existing natively drawn Linux PNGs, without resampling.

Windows always returns `unsigned` at `resolveSigning`; Apple credentials are
ignored. Authenticode can be introduced at this seam later. The x64 app bundles the
`windows-x64` Daemon for This PC (a release carries only that build; arm64 has no
local Host and bundles none), plus koffi for the local pipe's owner check:
its JavaScript in the asar and `resources/koffi/win32_x64/koffi.node`
(`koffi.ts`, [ADR 0062](../../../../docs/adr/0062-the-desktop-app-checks-the-local-pipes-owner.md)).
Packaging x64 from a Mac needs koffi's win32-x64 build installed
(`bun install --os win32 --cpu x64`). WSL distros and remote Hosts download their Daemons. `--windows` requires `--reuse-daemon` and an existing verified
manifest; it never builds, signs or rewrites Daemon files. Release versions must
match. The release workflow archives the final Daemon dist (after `sign` for a signed
release); the Windows job checks the tarball's SHA-256, restores it and verifies the copied bytes again.
Both jobs share `.github/actions/package-windows`.

For test installers without a release, run the "Windows test build" workflow
(`gh workflow run windows-test-build.yml --ref <branch>`). It builds a dev Daemon
on macOS, packages installers at the Desktop App's package version (`0.0.1-dev` while it is `0.0.0`) for both architectures, smoke-tests x64,
and keeps `polaris-windows-<arch>-unsigned-experimental` as artifacts for 14 days.

Under `out/dist/squirrel-<arch>/`:

- `Polaris-<version>-<arch>-win-Setup.exe`
- `Polaris-<arch>-win-<NuGet version>-full.nupkg`
- `RELEASES`, and its GitHub asset alias `Polaris-<version>-<arch>-win-RELEASES`

NuGet removes prerelease dots (`1.2.3-alpha.1` becomes `1.2.3-alpha1`; the release workflow takes this name from `tooling/release/metadata.py`). Squirrel compares these SemVer 1 strings lexically, so `alpha10` sorts before `alpha9`; the site feed compares semver and serves only stable releases. Package IDs
include the architecture so feeds cannot offer an incompatible executable.
Only full packages are published; delta generation is disabled until a
previous-release artifact contract exists. Each RELEASES hash/size is checked
against the generated nupkg before upload. Bun skips the dependency's install
script, so the installer seam copies its vendor tools into a temporary folder
and selects the build Host's 7-Zip binaries there. It adds no trusted dependency.
The standard licence gate passes; the build-only package declares MIT.

Windows packages enter through a small Squirrel bootstrap. Maintenance launches
create/remove shortcuts with Electron's native Windows API before importing the
Client runtime. The target and working directory stay at the install root;
Squirrel's application and toast activation IDs are retained. This avoids a
second .NET process inside Squirrel's hook deadline. Temporary vendor cleanup retries transient
Windows file locks for a bounded interval.

The Squirrel launcher's version scan ignores `app-0.0.0`. Windows development
packaging maps the repository's placeholder `0.0.0` to `0.0.1-dev`; a release
at `0.0.0` is rejected. Other release and prerelease versions are unchanged.

`windows-smoke.ps1 -Installer <Setup.exe> -Arch <x64|arm64>` installs on a fresh
Windows account/throwaway VM and waits for an actual Polaris window handle.
It uses isolated settings with the local Host and automatic update checks off.
It refuses to overwrite an existing installation, stops only that installation's
processes, and removes only its temporary settings. It leaves the installation
and shortcuts in place. The release job runs it for x64 on `windows-latest`;
arm64 installation/launch still requires the owner's Windows arm64 VM.

It then reaches a local Daemon over its named pipe with
`apps/daemon/scripts/windows-pipe-smoke.ps1`: the Daemon serves a throwaway
Polaris home and the real Client says hello, runs `git.status` and a Terminal.
That Daemon is the installed app's `resources\daemon\windows-<arch>\polaris.exe`
(the x64 package carries one), else `-Daemon <polaris.exe>`, which CI passes as the
restored `apps/daemon/dist/windows-x64/polaris.exe`. With neither, the script warns
that the pipe went unchecked.

Last, the Desktop App connects to This PC itself (`windows-connect.ps1`, ENG-331). With the
first window closed, `windowsConnect.ts` launches the installed `app-*\Polaris.exe` under
Playwright with the local Host on and `POLARIS_DESKTOP_LOCAL_SOCKET` / `POLARIS_DESKTOP_LOCAL_HOME`
naming a throwaway home's pipe, the same test hooks `packageCheck.ts` uses, so the build adds no
smoke-only code. Nothing is installed there, so the app installs its own
`resources\daemon\windows-x64\polaris.exe` into that home (a sign-in task, ADR 0060) and the
check waits on the `machines` feed for This PC's Connection State to be `connected`
(`APP CONNECTED: …`), then that one new task is `dev.lux.polaris.<user>.<hash>`. Teardown always
runs the package's `polaris.exe uninstall --purge` with that `POLARIS_HOME` and fails unless the
sign-in tasks are as before (the profile's own `dev.lux.polaris.<user>` unchanged), no Daemon runs
from the home, and the home is gone (`TORN DOWN: …`). The arm64 package carries no Daemon, so it
warns that the connection went unchecked. `windows-connect.ps1` also runs alone against an
installed app (`-Application`, `-Daemon`, and `-Scratch <dir>` for the throwaway home's parent).

All Playwright launches use `scriptedElectron` from `scripts/lib/electron.ts`. Scripted mode
omits the local Host unless given a temporary fixture socket, and disables local installation
and upgrade by default, even with `POLARIS_DESKTOP_LOCAL_HOME`. The dedicated
`windowsConnect.ts` and `oldDaemon.ts` install smokes require
`POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL=1` and a canonical temporary home; the PowerShell
runner sets and restores that opt-in. On macOS they also require CI (`CI=1` or `true`) or
`POLARIS_DESKTOP_SCRIPTED_VM=1`, which attests that the caller is running in a disposable VM.
A temporary HOME moves the LaunchAgent plist but still uses the shared
`dev.lux.polaris` launchd label and the account's real UID; these smokes refuse otherwise.
