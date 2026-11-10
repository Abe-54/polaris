# Computer use on this Host (ENG-846)

`ComputerUseHost` answers this Host's computer use status (`packages/protocol/computer-use.md`), keeps computer use on or off and the always-allowed apps, and serves the Host feed. The helper app and its launcher are in `service/computerUse/`; agent-desktop's install is in `install/agentDesktop/`.

| File | What |
|---|---|
| `host.ts` | `ComputerUseHost`: `current`, `ensure`, `changes`, `desktopEnv`, `enable`, `disable`, `openSetup`, the allowed list (`allowApp` for an approval's "Always allow", `addAllowedApp` for Settings' add, `removeAllowedApp`), `setControlledApps` and `feed`. `stateOf` is the order of the states. |
| `desktop.ts` | `detectDesktop`: whether there is a desktop session, found by the Daemon itself. |
| `linux.ts`, `mac.ts` | What each platform still needs (`NeedsSetup`), and the setup commands on macOS. |
| `feed.ts` | `computerUse.watch`: a `Status`, `AllowedApps` and `ControlledApps` first, then each again when it changes. |
| `control.ts` | `AppControl`: the policy at run time. Each `polaris_desktop` call on an app goes through `decideAppUse`; an approval is asked through the Engine (`requestAppApproval`, bound in `transport/serve.ts` once the Engine is up). A session's approvals are folded from its log on first use (`foldApprovals`), so they survive a restart and go when it is archived. Controlled apps live in memory, go to the Host feed, and are released at a Turn's end, when the session stops and when computer use is turned off. |
| `refused.ts` | The built-in always-refused apps by bundle id: terminals, script runners, System Settings, Keychain Access, Passwords and password managers, and Polaris (`dev.lux.polaris*`). A refused app never opens an approval, so no card's "Always allow" can lift it: the call is refused with a message naming the Host's computer use settings. Only an app already on the Host's always-allowed list is not refused. By name only where the Host gives apps no id. |
| `storage.ts` | `~/.polaris/computer-use.json` (mode 600): `enabled` and the always-allowed apps. A missing or unreadable file reads as off with no apps. |
| `probe.ts` | `hostProbe`: the only process boundary. It covers the platform, the Daemon's environment, files, Unix sockets and short commands (5 s timeout). Tests point it at a temp directory with fake commands on `PATH`. |
| `rpc.ts` | The seven `computerUse.*` RPCs for status, setup, on/off and the allowed list. `computerUse.app` and the preview still answer `Unsupported` from `transport/computerUseDefaults.ts`. |

## The status

The states are checked in this order. A check skips what an earlier state already rules out.

1. **No desktop.** agent-desktop answers the same with no desktop and with no AT-SPI, so the Daemon looks first:
   - **macOS**: `/dev/console` belongs to the Daemon's user. It belongs to root at the login window and to the other user after fast user switching. A locked screen still counts as a desktop.
   - **Linux**: a `WAYLAND_DISPLAY` (relative to `XDG_RUNTIME_DIR`, or `/run/user/<uid>`) or a local `DISPLAY` (`:n`, with `/tmp/.X11-unix/X<n>`) in the Daemon's own environment, whose socket accepts a connection. Without one, the user's logind sessions are read (`loginctl show-user <uid> -p Sessions`, then `show-session … -p Type -p Active -p Remote -p Seat -p Display`), looking for an active, local `wayland`, `x11` or `mir` session on a seat. `DISPLAY=localhost:10.0` (SSH forwarding) is not this Host's desktop. `desktopEnv` gives agent-desktop the display, the runtime directory and the session bus it found.
   - **Windows**: the Daemon's own session (`tasklist /FI "PID eq <pid>"`) is not session 0, and `explorer.exe` runs in it.
2. **Off**, until `computerUse.enable`. Nothing past the desktop check runs while it is off.
3. **Needs setup**:
   - **macOS**: `agent-desktop status`, run inside the helper app (`ComputerUseHelper.permissions`). It reads Accessibility and Screen Recording separately. tccd charges the query to the helper's own identity, and the query is a preflight that never prompts: with the helper not granted, tccd logs `preflight=yes` and "Service kTCCServiceAccessibility does not allow prompting" for each query. A Daemon without the helper beside it (one run from source) reads as both missing.
   - **Linux**: at-spi2-core must be installed, found by its D-Bus service file `org.a11y.Bus.service`. If it is missing, the status gives the package and the install command for the first package manager on `PATH` (apt-get, dnf, zypper, pacman, apk), or null. If it is installed, `org.a11y.Bus.GetAddress` is asked on the desktop's session bus, and the registry is pinged on the bus it names (`busctl`, else `dbus-send`). This is what agent-desktop's own probe reads. If neither answers, the status is `AccessibilityBus`. With neither tool, the bus isn't checked.
4. **Ready.**

**Nothing polls.** The first `current` checks the Host, and so do `computerUse.status { refresh: true }`, `enable`, `disable` and `ensure`. `ensure` is what a session that needs computer use calls. Watching the feed never checks. The one exception is that after `openSetup` the Host is checked every 2 s for at most 3 minutes, and only while it still needs setup, so the status turns `Ready` once the user drags the helper in.

## Setup

`openSetup` on macOS reveals `Polaris Computer Use.app` in Finder (`open -R`), then opens Privacy & Security at Accessibility. On macOS 27 that pane is Device Control and Data Access, the one step for both grants, so `permission: null` opens it too. `screen-recording` opens Screen Recording. Elsewhere `openSetup` fails with `ComputerUseSetupFailed`, which gives the Host's next step in words, for example "Run `sudo apt-get install -y at-spi2-core` on this Host, then check again." Installing a package needs root, which the Daemon never has.

## Verified

On a Mac Studio (macOS 27.0, arm64) through the real code, `NeedsSetup MacPermissions { accessibility: false, screenRecording: false }` with a helper whose identity was never granted, and `Ready` with the dev helper after it was dragged in. On lucas-rpi (Debian 13, labwc, seat0 Wayland), `NeedsSetup LinuxPackages at-spi2-core` both from the service manager's environment and from an SSH shell without a display (through logind). On a headless Ubuntu 24.04 VM, `NoDesktop`. In Debian 13 under Xvfb (Docker): `LinuxPackages` before installing at-spi2-core, `Ready` after it (through `dbus-send` and through `busctl`), `AccessibilityBus` on a session bus that cannot start the accessibility bus, and `NoDesktop` with no display. Windows has not been run.
