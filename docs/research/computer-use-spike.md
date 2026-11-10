# Computer use spike: agent-desktop under the macOS Daemon

[ENG-846](https://linear.app/luxdev/issue/ENG-846), 2026-11-09. agent-desktop v1.2.0 (tag `2b0a733`, release
tarballs checked against `checksums.txt`), run as a binary. Mac: macOS 27.0 (26A428), arm64. The test
Daemons were dev builds of `a6f5177` (`0.8.5-dev.3405`, ad hoc) under their own launchd labels
(`dev.lux.polaris.spike`, `spike2`) with `POLARIS_HOME=/tmp/cu/h`. Each Daemon's login-shell PATH probe
(`SHELL=` in the plist) started a command runner, so every command below ran as a child of a launchd
Daemon, like a Harness does. The release Daemon (0.8.5, Developer ID) was observed only through this
agent's own process chain: launchd → `polaris` → `claude` → `zsh`.

## 1. Which app TCC charges

**PolarisDaemon.app.** For both builds, tccd names the Daemon as the responsible process for every
agent-desktop request, including the guide helper and the overlay child:

```
AUTHREQ_ATTRIBUTION: responsible={identifier=dev.lux.polaris.daemon, pid=92076,
  responsible_path=~/.polaris/bin/0.8.5/PolarisDaemon.app/Contents/MacOS/polaris},
  accessing={identifier=agent_desktop-11932f6d169343a7, binary_path=/tmp/cu/mac/agent-desktop}
AUTHREQ_ATTRIBUTION: responsible={identifier=dev.lux.polaris.daemon, pid=5918,
  responsible_path=/private/tmp/cu/b/PolarisDaemon.app/Contents/MacOS/polaris}, accessing={agent_desktop-…}
```

The requirement that grants match differs by build. A Developer ID build matches on `identifier
"dev.lux.polaris.daemon" and anchor apple generic … leaf[subject.OU] = HWD6374DUX`, which stays the
same across versions. An ad hoc build matches on `cdhash H"cc23b23c…"`, which changes on every build
and every re-sign. Dev and release builds share the bundle id, so they compete for one TCC row. After
the user granted the release Daemon, the dev build logged `Failed to match existing code requirement
for subject dev.lux.polaris.daemon and service kTCCServiceAccessibility`, and stayed denied.

**Where the second "agent-desktop" entry came from.** No request was ever charged to agent-desktop
itself. Its row (`/tmp/cu/mac/agent-desktop`, `cdhash H"a5c90a22…"`, `Allowed (System Set)`) was made by
hand in System Settings, because the guide says "if System Settings lists the agent-desktop binary
separately, grant it too". No check reads that row: while it was on, the dev Daemon still read
`denied`. Test 2 copied agent-desktop into `Contents/MacOS` and gave the bundle its own id
(`dev.lux.polaris.daemon.spike`). It produced exactly two TCC records, both for the bundle:
Accessibility `Allowed` at 18:01:38 and ScreenCapture `Allowed` at 18:01:51. There was no agent-desktop
entry.

**A separate helper app works.** "Polaris Computer Use.app" (`dev.lux.polaris.computer-use.spike`,
with `CFBundleExecutable` set to agent-desktop) was started from the Daemon through
`posix_spawn` with `responsibility_spawnattrs_setdisclaim(1)`. stdio was inherited, so MCP over stdio
still works. tccd then charged the helper itself: `accessing={identifier=dev.lux.polaris.computer-use.spike}`,
with no responsible Daemon, and it read `denied` until granted. The same binary spawned without the
disclaim was charged to the Daemon and read `granted`. Codex ships the same pattern: "Codex Computer
Use.app" sits in this Mac's list.

## 2. Prompts from the Daemon, and the name shown

- Both `permissions --request` and `--guide` run from the Daemon. `--guide` opens System Settings
  with agent-desktop's panel: "Drag PolarisSpike · STEP 1 OF 2 · Allow Device Control and Data Access".
- A plain `permissions`, documented as "does not prompt", started `universalAccessAuthWarn` in the
  same second (17:50:16). The user then saw a system prompt for the release Daemon.
- **The name is the bundle's folder name, not `CFBundleDisplayName`.** Both bundles had
  `CFBundleName` and `CFBundleDisplayName` set to "Polaris". Prompts showed "PolarisDaemon" and
  System Settings rows show `<folder>.app` (`AeroSpace.app`, `Codex Computer Use.app`). The guide said
  "Drag PolarisSpike". Requirement: the name the user sees must be "Polaris", so the folder has to
  carry it.
- On macOS 27, Accessibility and Screen Recording are one pane, **Device Control and Data Access**,
  and an app is added by dragging it in. TCC still writes two records, one per service, 13 s apart.
  The old "Screen & System Audio Recording" pane still exists, but the granted bundle wasn't listed
  there.

## 3. Cursor overlay under LSBackgroundOnly + LSUIElement

**It renders, and no fix is needed.** From both Daemons (both `LSBackgroundOnly` and `LSUIElement`),
`cursor-overlay enable` returned `"rendered":true`. A re-executed `agent-desktop` child (parent pid 1)
owned two on-screen windows at layer 103: a 240×240 cursor and a 240×40 label. The user saw the cursor
moving. One `type` logged `cursor overlay travel was not acknowledged … os error 35`, and the action
still landed. Labels are cut to 6 words by default (12 at most), so session titles will be truncated.

## 4. Headless actions

Results through the release Daemon, with Accessibility granted. Recorded in `q4-headless.jsonl`.

| Action | Result |
|---|---|
| TextEdit `set-value` | `delivered_verified`; the value is "set by set-value" |
| TextEdit `type` | `delivered_verified`; the value gained " +typed" |
| `press cmd+a --app TextEdit` | `delivered_unverified` |
| `mouse-click`, `double-click` without `--headed` | `POLICY_DENIED`, `not_delivered` |
| Dia `snapshot` (headless or `--headed`) | `ACTION_NOT_SUPPORTED`: "Renderer did not enable accessibility activation" |

The frontmost app stayed Polaris for every action, so nothing took focus. The pointer moved between
reads, but the user was using the Mac at the time and it never landed on a target. Per the CLI's
help, `--headed` is needed for `double-click`, `triple-click`, `hover`, `drag` and `mouse-*`, and for a
physical `click`, `type` or `scroll`. Headed actions focus the window. **Dia** (Chromium) exposes no
web accessibility tree once it is running. agent-desktop's fix is a fresh `launch --cdp`, which means
quitting the user's browser. That backs "web tasks prefer polaris_browser".

## 5. ScreenCaptureKit single-window capture

The helper is a 65-line Swift tool in the bundle's `Contents/MacOS`, covered by the bundle's Screen
Recording grant. It runs `SCContentFilter(desktopIndependentWindow:)`, BGRA frames scaled to 640 px
wide, then CIImage → JPEG at quality 0.7. Each run is 10 s.

| Window | Cap | fps | JPEG | Helper CPU | WindowServer CPU |
|---|---|---|---|---|---|
| Dia 2032×1106, canvas animating | 10 | 10.2 | 15.9 KB | 3.9% | 59.8% |
| same | 30 | 28.5 | 17.6 KB | 9.9% | 64.8% |
| same | 60 | 55.4 | 15.9 KB | 19.7% | 82.8% |
| TextEdit 673×439, caret only | 30 | 29.0 | 10.0 KB | 10.6% | 55.7% |

CPU is a percentage of one core. WindowServer measured 41.5% with Dia animating and no capture, so
capture adds about 15–40% in WindowServer, plus 2–4% in `replayd`. Frames arrive at the cap even for a
static window (`idleFrames` 0), so the helper must throttle or deduplicate frames itself. The stream
starts about 0.7–1.1 s after launch. **When not capturing, the cost is zero**, as long as the helper
runs only while someone is watching and exits otherwise. A resident idle helper wasn't measured.

## 6. Linux: what `status` reports

| Host | Session | `accessibility` | `screen_recording` |
|---|---|---|---|
| devbox: Ubuntu 24.04 x64, no display, over SSH | none | `denied` (AT-SPI "not installed or not visible") | `unknown` |
| devbox under `Xvfb :99` + `dbus-run-session` | X11 | `denied` (same) | `not_required` |
| rpi: Debian 13 arm64, labwc, seat0 `Type=wayland` | Wayland; polaris.service has `WAYLAND_DISPLAY`, `DISPLAY` | `denied` (same) | `unknown` |

`status` returns the same answer with no desktop and with a desktop that lacks `at-spi2-core` (not
installed on either Host). It cannot tell the two apart. On labwc, `list-displays` returns "Displays
cannot be listed on this Wayland session … Run under GNOME". The Daemon has to check for a desktop
itself: an active graphical seat session (`loginctl show-session -p Type -p Seat`), or a live
`WAYLAND_DISPLAY`/`DISPLAY` socket in the service's environment. Only after that should it ask
agent-desktop. On Linux the next step is to install a package (root), not to grant a permission.

## Decisions in ENG-846 that these findings break

1. **"Permissions belong to PolarisDaemon.app, which needs a readable display name."** Display-name
   keys don't change what the user sees, and a grant on the Daemon covers every Daemon child, not
   just computer use. Dev and release builds also fight over one row. **Proposed:** ship
   **"Polaris Computer Use.app"** (`dev.lux.polaris.computer-use`, Developer ID) holding agent-desktop
   and the capture helper, spawned with responsibility disclaimed. Its name reads well and its grant
   covers computer use only. Its designated requirement (id + team) survives both Daemon and
   agent-desktop upgrades. The catch: the disclaim call is private SPI, though Chromium relies on it.
   The public fallback is to launch the helper through LaunchServices and talk to it over a socket.
   If the helper is rejected, rename the Daemon's folder to `Polaris.app`, give dev builds their own
   bundle id, and put agent-desktop under `Contents/MacOS`.
2. **"A checklist (Accessibility, Screen Recording) that the Daemon triggers."** On macOS 27 this is
   one drag-in step in one pane. Prompts can't be relied on, and agent-desktop's guide names the
   folder. **Proposed:** a single "Allow computer use" step that opens Device Control and Data Access
   with our own copy and the helper to drag in. Keep reading the two services separately for status.
3. **"Host status: no desktop, needs permissions, off, ready."** Linux can't tell no desktop from
   missing AT-SPI. **Proposed:** `no desktop` (detected by the Daemon) and `needs setup`, with a
   reason: macOS permissions, or the Linux package and accessibility bus.
4. **"Linux gets … the last screenshot."** Not shown on Wayland outside GNOME. Expect no screenshot
   there.

## Confirmed and not confirmed

Confirmed on this Mac:
- TCC charges both builds to the Daemon.
- Ad hoc grants are keyed to the cdhash, and dev and release builds share one row.
- Prompts and System Settings show the folder name.
- An embedded agent-desktop under the bundle's own id leaves one entry.
- A disclaimed spawn makes a helper app its own TCC identity.
- The overlay renders with LSBackgroundOnly.
- Headless set-value and type work on TextEdit without taking focus. Dia refuses.
- Capture rates and CPU are as in the table.
- Linux `status` gives the same answer with and without a desktop.

Not confirmed:
- A Developer ID helper app keeping its grant across an upgrade. Inferred from its requirement.
- Granting and using the helper app end to end, including the overlay. Its row was never granted.
- Whether a pointer move came from agent-desktop or the user.
- Headless actions on Dia web content.
- The cost of a resident idle capture helper.
- Linux with `at-spi2-core` installed (it needs root on the Hosts), and GNOME Wayland.
- Windows.
- A real Harness spawning `agent-desktop mcp`. The runner reproduces a Harness's process chain, and
  the release-chain checks ran inside a real Claude Code session.

Spike code (runner, capture helper, disclaim launcher) lives in `/tmp/cu` and is not in the tree.
