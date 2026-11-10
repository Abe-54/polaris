# Simulator hub spike: expo-device-hub and agent-device under the Daemon's Bun (ENG-829)

Task S of the Simulator constellation, 2026-11-09, on a Mac Studio (arm64, macOS 27.0,
Darwin 27.0.0). This spike proves the engine that ADR 0099 chose and records the facts the
other Tasks build on. Everything ran from a scratch directory under `/tmp/spikeS`; nothing is
added to the repo except this file.

Versions:

- `expo-device-hub@0.21.0` (MIT; vendors serve-sim and serve-emu, both Apache-2.0, serve-sim
  forked from EvanBacon/serve-sim). Upstream tag `expo-device-hub@0.21.0` is commit
  `c8255afb869287f307d8f80be17aa4067ff48aed` of github.com/expo/expo-device-hub; the source
  references below are paths in that commit.
- `agent-device@0.21.36` (MIT, Callstack).
- The repo's Bun, `bun@1.4.4` (`packageManager`), and the installed Daemon,
  `~/.polaris/bin/current/polaris` (0.8.5, embedding Bun 1.4.4).

## Answer

**The hub and agent-device run under the Daemon's Bun, unchanged.** Both run with the repo's
`bun` 1.4.4 and with the compiled Daemon (`BUN_BE_BUN=1 ~/.polaris/bin/current/polaris`).
The Swift addon loads, and the device list, both video streams and `/ws` input (tap and the home
button) work. agent-device's `open`, `snapshot`, `press` and `screenshot` work too. No Node was
needed, so the decided Node fallback is not needed for iOS. Android was not run (no SDK on this Mac).

Live runs used a throwaway iPhone Duo on iOS 27.1 (`polaris-spike-S`, the only iPhone that
runtime offers here) and an iPhone 17 Pro on iOS 27.0 (`polaris-spike-S-2`). Both were deleted
afterwards, and the hub's and serve-sim's state files for them were removed.

| Hub CPU (one process; % of one core) | Bun | `polaris` |
|---|---|---|
| Running, no capture session | 0.03% (52 MB) | 0.15% (49 MB) |
| Capture session open, no viewer | 1.97% | 1.77% |
| One `stream.avcc` viewer | 2.10% | 2.17% |
| One `stream.mjpeg` viewer | 10.37% (158 MB) | not measured |
| Viewers closed, session still open | 1.50% | — |
| Two sessions (Duo + 17 Pro), no viewer | — | 2.65% |
| Hub stopped (SIGTERM) | 0 (process gone) | 0 |

## Install

```sh
mkdir -p /tmp/spikeS/pkgs && cd /tmp/spikeS/pkgs
npm pack expo-device-hub@0.21.0 agent-device@0.21.36

mkdir -p /tmp/spikeS/hub && cd /tmp/spikeS/hub
cat > package.json <<'EOF'
{ "name": "spike-hub", "private": true,
  "dependencies": { "expo-device-hub": "0.21.0", "agent-device": "0.21.36" },
  "trustedDependencies": ["node-datachannel"] }
EOF
bun install          # 11 packages, ~1 s, 53 MB of node_modules
```

The hub's runtime dependencies are `ws`, `@fastify/busboy`, `mediabunny`, `node-datachannel`
(a native WebRTC addon, used only by serve-emu, the Android backend) and `zustand`.
agent-device has no runtime dependencies (7.3 MB); its `engines` says `node >=22.12`. The
serve-sim N-API addon ships prebuilt at
`vendor/serve-sim/dist/native/serve-sim-native.node` (1.9 MB, arm64), next to
`LiveKitWebRTC.framework` and the small `simax`, `simcam` and `simpb` helpers.

For the Daemon, this is a pinned tarball pair plus a lockfile, not a single binary like
agent-browser's (`apps/daemon/src/install/agentBrowser`). The installer has to unpack two npm
tarballs and their five dependencies (or one prebuilt `node_modules` archive we produce),
verified by hash the same way `downloadFile` does today.

## Bun

| What | `bun` 1.4.4 | `BUN_BE_BUN=1 polaris` (0.8.5) |
|---|---|---|
| `cli.mjs --help` | works | works |
| `require("serve-sim-native.node")` | loads; exports `SimCapture, SimHID, axDescribe, axFrontmost, axKeyboardVisible, axTypeKeyboardCharacter, setHardwareKeyboard` | same |
| `agent-device --version` | `0.21.36` | `0.21.36` |
| Hub against a booted Simulator: device list, `/grid/api/start`, `stream.avcc`, `stream.mjpeg`, `/ws` tap and home | works (Duo, iOS 27.1) | works (Duo, iOS 27.1, and iPhone 17 Pro, iOS 27.0) |
| agent-device `open`, `snapshot -i`, `press --settle`, `screenshot`, `close`, `daemon stop` | works; its daemon runs as `bun …/daemon.js` | works; its daemon runs as `polaris …/daemon.js` (inherits `BUN_BE_BUN`) |
| SIGTERM to the hub | exits in 2.4 s, Simulator stays booted | exits in ~11 s (two devices, one just shut down), Simulator stays booted |

Commands:

```sh
H=/tmp/spikeS/hub/node_modules/expo-device-hub
bun $H/dist/server/cli.mjs --host 127.0.0.1 --port <free> --require-token
BUN_BE_BUN=1 ~/.polaris/bin/current/polaris $H/dist/server/cli.mjs --host 127.0.0.1 --port <free> --require-token
bun /tmp/spikeS/hub/node_modules/agent-device/bin/agent-device.mjs <command>
```

Upstream already runs on Bun: the package's own `cli` script is `bun dist/server/cli.mjs`,
and serve-sim carries Bun workarounds. `socket/server-upgrade.ts` completes the WebSocket
handshake by hand because "the `ws` server's handshake doesn't flush under Bun", and
`socket/server-input.ts` `rawHidSocket` parses WebSocket frames itself for the same reason.

One spawn to know about: `GET /vendor/serve-sim/` (the preview root), without
`--single-device`, calls `ensureHelperSpawned()`, which runs
`spawn(process.execPath, [serve-sim.js, "--detach", "--quiet"], { detached: true })` and
`unref()`s it (`dist/server/index.mjs:12109`). That child outlives the hub. Under the
compiled Daemon, `process.execPath` is the `polaris` binary, and it inherits
`BUN_BE_BUN=1` from the environment, so it still runs as Bun. The Daemon must never load
that page, or must start the hub with `--single-device <udid> --platform ios`, which skips
the spawn.

## The token

`--require-token` makes the hub generate its own token, `randomBytes(32).toString("base64url")`
(`cli.mjs:1382`). It can't be supplied: the CLI overwrites `EXPO_DEVICE_HUB_SESSION_TOKEN`.
The hub prints it in the startup banner (`http://127.0.0.1:<port>/?token=<token>`) and
writes `{ pid, port, url, token }`, mode 0600, to `$EXPO_DEVICE_HUB_STATE_DIR/server-<port>.json`
(default `$TMPDIR/expo-device-hub/`), removing the file on exit. The Daemon should set
`EXPO_DEVICE_HUB_STATE_DIR` to a directory under its own home and read the token from there.

How a request presents it (`index.mjs:12336`, `authorizeRequest`):

- HTTP: `Authorization: Bearer <token>`. `?token=<token>` also works except under
  `/vendor/serve-sim/network-capture`; for an HTML request it 302s and sets a cookie.
- WebSocket: `Authorization: Bearer <token>`, or a subprotocol `serve-sim.token.<token>`
  (iOS) or serve-emu's prefix (Android), or the cookie on a same-origin request.
- Ungated: `/healthz`, `/readyz` and `/_eas/android-recording/stop` (which has its own token).

Without `--require-token`, loopback is the only protection. The Daemon must always pass it.

## Routes the Daemon and Desktop App use

All paths are relative to the hub's root (the standalone CLI sets the mount path to `""`).
serve-sim is mounted at `/vendor/serve-sim`, serve-emu at `/vendor/serve-emu`.

### Hub

| Route | Method | Body / query | Response |
|---|---|---|---|
| `/healthz` | GET | | `{"status":"ok"}` (ungated) |
| `/readyz` | GET | | `{"status":"ready","device":"no-device-id"}` (ungated) |
| `/api/devices` | GET | `?booted=1` filters to booted | `{ simulators: Device[], emulators: Device[], errors: string[] }` |
| `/api/devices/boot` | POST | `{ platform, id, name }` | `{ ok: true }` or `{ ok: false, error }` |
| `/api/devices/shutdown` | POST | `{ platform, id, name }` | same |
| `/api/devices/remove` | POST | `{ platform, id, name }` | same (deletes the device) |
| `/api/devices/create` | POST | `{ platform, name, runtime, deviceType }` | same |
| `/api/new-device-options` | GET | | runtimes and device types to create with |
| `/api/devices/ws` | WS | | pushes the device list on change |
| `/metrics` | GET | | 307 to `/vendor/serve-sim/metrics` |

`/api/devices?booted=1` as served (verified):

```json
{
  "simulators": [
    { "id": "FCE82B83-…", "name": "polaris-spike-S", "version": "iOS 27.1", "platform": "ios",
      "booted": true, "physical": false, "supported": true, "deviceFrame": null,
      "lastUsedAt": 1794253862000 }
  ],
  "emulators": [],
  "errors": [
    { "id": "9f9eabe0…", "message": "[android-utils] Failed to run `avdmanager list avd`:",
      "error": "Error: ENOENT … avdmanager …" }
  ]
}
```

`errors` holds objects (`{ id, message, error }`, where `error` is a stack trace with local paths),
not the strings the device-list socket sends. On a Mac without the Android SDK every call carries
the `avdmanager` ENOENT error, so the Daemon must not show it as a failure.

### iOS (serve-sim, under `/vendor/serve-sim`)

| Route | Method | What |
|---|---|---|
| `/grid/api/start` | POST | `{ "udid": "<UDID>" }` (not `device`, which gets 400 `Invalid or missing udid`): boots the device if needed and writes serve-sim's per-device state; `{ "ok": true }` in 3.8 s for a booted Duo. It does not start capture by itself, and the streams work without it. |
| `/grid/api/shutdown` | POST | `{ "udid": "<UDID>" }`: closes the capture session **and shuts the simulator down** (`stopDeviceInProcess`, `device-lifecycle.ts`); `{ "ok": true }` in 3.5 s. |
| `/grid/api/status` | GET | point-in-time status of every device |
| `/grid/api/status/events` | GET | SSE of status changes |
| `/helper/<udid>/stream.avcc` | GET | H.264 in AVCC envelopes (below); starts capture |
| `/helper/<udid>/stream.mjpeg` | GET | `multipart/x-mixed-replace; boundary=frame` JPEGs; `?raw=1` gives octet-stream; starts capture |
| `/helper/<udid>/stream-settings` | GET/POST | runtime encoder settings |
| `/helper/<udid>/config` | GET | `{ width, height, orientation, … }` |
| `/helper/<udid>/ax` | GET | accessibility tree (axe-shaped JSON) |
| `/helper/<udid>/foreground` | GET | `{ bundleId, pid }` |
| `/helper/<udid>/health` | GET | `{ "status": "ok" }` |
| `/helper/<udid>/webrtc/offer`, `/webrtc/close` | POST | WebRTC signalling (only with `--transport webrtc`) |
| `/helper/ws?device=<udid>` | WS | input (below); `/helper/<udid>/ws` also routes |
| `/exec-ws` | WS | the exec channel (runs commands on the Host; never expose) |
| `/api/screenshot` | GET | a screenshot |

The `/helper/<udid>/…` prefix comes from `helperProxyTarget` (`src/middleware.ts:657`): a
first segment that isn't a known endpoint is taken as the UDID; `?device=<udid>` works too.

Verified live, with `Authorization: Bearer <token>`:

- `/healthz` 200 without a token; `/api/devices` 401 without one.
- `stream.avcc`: `application/octet-stream`. The first chunk arrives 6.6 s after the request on a
  cold session (capture startup), 0.6–1.4 s once the device was started, and 2–5 ms with a session
  already open. Each connect gets one `0x04` seed, then `0x01` description and `0x02` keyframe
  (each arrived twice on every connect; the cause was not checked), then `0x03` deltas. About 180–250 kbit/s on a still home
  screen, 500–700 kbit/s while the screen changes.
- `stream.mjpeg`: `multipart/x-mixed-replace; boundary=frame`, ~11–12 Mbit/s at the same 4.6 fps,
  60 times the bandwidth of AVCC and 5 times the hub CPU. **The first JPEG on connect is the last
  frame cached before the connect,** so it can show the screen before the latest input. Read a later
  one.
- `/helper/<udid>/config`: Duo
  `{"width":1398,"height":2034,"orientation":"portrait","inputUnavailable":false,"keyboardUnavailable":false,"screenId":1,"supportsPhysicalOrientation":true,"supportsHingeAngle":true,"supportsHingeStateReadback":true,"hingeAngle":0,"hingePose":null,"tableModeAvailable":false,"observedDeviceState":{"hingeAngle":0,"physicalOrientation":"portrait"}}`;
  iPhone 17 Pro `1206×2622`, `supportsHingeAngle: false`. The Duo boots closed, on its outer panel
  (466×678 pt at 3×).
- `/vendor/serve-sim/metrics` is **Server-Sent Events**, not JSON: `event: meta` with
  `{"schemaVersion":1,"udid":…,"deviceName":…,"hostCores":12,"sampleIntervalMs":1000}`, then
  samples each second. A plain GET never ends.
- `xcrun simctl io <udid> screenshot` fails on the Duo (`Invalid argument`); the hub's MJPEG frame
  and agent-device's `screenshot` both work.

### `/stream.avcc` framing

From `Sources/SimNative/StreamFormat.swift` and `src/client/avcc-codec.ts`. Each chunk is
`[len: u32 BE][tag: u8][payload]`, where `len = payload.length + 1`:

| Tag | Chunk | Payload |
|---|---|---|
| `0x01` | description | the avcC blob (SPS/PPS) that configures a WebCodecs `VideoDecoder`; replayed to late joiners |
| `0x02` | keyframe | an IDR frame, in AVCC (length-prefixed NAL) form |
| `0x03` | delta | a non-IDR frame |
| `0x04` | seed | a JPEG of the current screen, sent first on connect so a viewer paints before the first IDR decodes |

The Desktop App decodes this with WebCodecs (`codec` from the avcC profile, `description` =
the 0x01 payload). For a remote Client the Daemon can forward these chunks as-is as a
byte stream (ADR 0093); they are already self-delimiting.

### `/ws` input protocol

From `src/socket/*.ts` and `src/device-session.ts` `attachHidSocket` / `handleHidMessage`.
Every message is binary `[tag: u8][UTF-8 JSON]`; touch coordinates are fractions of the
screen (0–1).

Server to client:

| Bytes | Meaning |
|---|---|
| `0x83` (one byte, alone) | **input admitted**: sent right after the socket is accepted |
| `0x82` + JSON | config: `{ width, height, orientation, … }`, sent after admission and on every change |
| close `1013` "Simulator input unavailable; retry after other clients disconnect" | refused: session not running, rebooting, or 8 input sockets already open |

Client to server (selection):

| Tag | JSON | What |
|---|---|---|
| `0x03` | `{ type: "begin" \| "move" \| "end", x, y, edge? }` | single touch; a tap is begin then end within 0.004 of the screen |
| `0x04` | `{ button: "home" }` (verified; other names go to native `hid.button`) or `{ button, page, usage, phase: "down" \| "up" \| "press" }` | hardware button |
| `0x05` | `{ type, x1, y1, x2, y2 }` | two-finger touch |
| `0x06` | `{ type: "down" \| "up", usage }` | HID keyboard key |
| `0x07` | `{ orientation: "portrait" \| "portrait_upside_down" \| "landscape_left" \| "landscape_right" }` | rotate |
| `0x0b` | `{ dx, dy, x?, y? }` | scroll, as fractions of the screen |
| `0x0c` / `0x0d` | — / `{ visible }` | toggle or set the software keyboard |
| `0x11` | `{ requestId: <positive int> }` (or no body) | **input barrier**: the server answers `0x91` + `{ requestId, ok }` (or `0x91, 0\|1` without a body) once every ordered message sent before it has been delivered to HID. `ok` is false if one of them failed or input is unavailable |

Ordered messages are tags `0x03`, `0x05`, `0x06`, `0x0b` and `0x0e`; a barrier waits for them
only. A button (`0x04`) is not ordered, so a barrier does not wait for it.

The server pings every 1 s and drops a socket that hasn't answered a pong for 10 s
(`HID_HEARTBEAT`, `socket/heartbeat.ts`). Input sent before `0x83` is queued client-side by
the reference client; a Polaris client must wait for `0x83` too.

Verified live on the Duo (Bun and `polaris`) and on the iPhone 17 Pro (`polaris`), with Bun's
`WebSocket` and an `Authorization` header (`/vendor/serve-sim/helper/ws?device=<udid>`):

- `0x83` arrives 1–7 ms after the socket opens, then a `0x82` config frame.
- A tap is `0x03 {type:"begin",x,y}`, then `0x03 {type:"end",x,y}` **about 60 ms later**. With
  begin and end 1.2 s apart, iOS took it as a long press and Settings did not open.
- A tap on Settings (Duo at (0.12, 0.125), 17 Pro at (0.88, 0.395)) opened Settings; the first
  AVCC frame after it came 86–203 ms after the end event. `0x04 {"button":"home"}` returned to the
  home screen, first frame after 6–57 ms.
- `0x11 {requestId}` was answered with `0x91 {"requestId":1,"ok":true}` within 3 ms.
- Closing the socket gives close code 1005 (no status).

## Stopping capture

Capture starts lazily: the first `stream.avcc`, `stream.mjpeg`, WebRTC offer or recording for
a booted device creates a `DeviceSession` (`getDeviceSession`, `src/device-session.ts:3137`),
which owns a native `SimCapture` and `SimHID`. **The session then lives until
`closeDeviceSession`**; closing the last viewer does not stop it. In this version only these
reach `closeDeviceSession`:

- `POST /grid/api/shutdown`, which also shuts the simulator down;
- the stale-state sweep, after the simulator has been shut down some other way;
- a screenshot that created the session itself (it closes the session afterwards);
- killing the hub (`SIGINT`/`SIGTERM` run `shutdownServeSim()`, which disposes every session).

There is no route that stops capture while keeping both the simulator and the hub running.
ADR 0099's plan holds: the Daemon stops capture by **stopping the hub process** (SIGTERM; it
exits within its own 60 s deadline) when no Agent Session shows the Simulator, and restarts it
on demand.

Verified live:

- After every viewer closed, the hub stayed at 1.5–2% CPU until it was stopped. The same
  happens with a session that a stream opened without `/grid/api/start`.
- SIGTERM to the Bun-run hub: it exited in 2.4 s, removed its own state file, and the Simulator
  stayed booted. A fresh hub then idled at 0.03–0.15% until the next stream. Under `polaris`,
  with a second device that had just been shut down, it took ~11 s and logged a CoreSimulator
  "device is not booted" error for that device first.
- SIGTERM leaves serve-sim's own per-device files in `$TMPDIR/serve-sim/`:
  `server-<UDID>.json` (pid, port, URLs, `streamSettings` and the dead hub's token, mode 0600),
  `capability-inserts-<UDID>.json` and `capabilities-<UDID>.conf`. The next hub doesn't clean
  them up while the device stays booted. The Daemon should give the hub a private `TMPDIR` and
  remove it on stop.
- `POST /grid/api/shutdown {udid}` stopped that device's session (hub CPU went from 2.65% to
  1.75% with the other device still streaming) and shut the device down.

## Wedge detection

I couldn't reproduce a wedge (expo/expo-device-hub#569) in this short run; every input
landed. These are the signals the protocol gives, and what they showed:

1. **Admitted:** the single byte `0x83` after connecting. Without it the socket closes with
   1013 (session not running, rebooting, or 8 input sockets open) or 1013 "Simulator input queue
   full; send smaller batches or slow down" (more than 1024 operations in flight on one socket).
2. **Delivered to HID:** send `0x11 {requestId}` after the input and wait for
   `0x91 {requestId, ok}`. An answer with `ok: true` means the touch reached native HID. No answer,
   or `ok: false`, means input is stuck before HID. The reference client gives up after 150 s; a
   Polaris client should use a few seconds. The `0x82` config frame also carries
   `inputUnavailable`.
3. **A new frame followed:** watch `stream.avcc` and record the arrival time of each `0x02`/`0x03`
   chunk. **A still screen is not silent:** a still Duo home screen produced about 4.5 delta frames
   per second (90 in 20 s; its status bar was animating, the cause is unconfirmed). Input
   that changed the screen produced 40–120 frames in the next 2 s, and the first came 6–203 ms
   after the input.

Wedge rule for the Daemon: after an input that should change the screen, a wedge is "`0x91` with
`ok: true` but the frame rate in the next ~500 ms doesn't rise above the stream's idle rate", or
"no `0x91` within ~2 s". Recover by stopping and restarting the hub (ADR 0099). Input that may
legitimately change nothing (a tap on empty space) can't be judged this way. Compare against
the idle rate measured on that stream, not against zero.

## Idle CPU

The numbers are in the table under "Answer". They are the hub process's CPU time over a 20–30 s
window (`ps -o time` before and after, for the pid and its descendants; it spawned none),
divided by the window, on a 12-core Mac Studio. The Simulator's own processes are not included:
they run whether or not the hub captures. The device was the Duo on its home screen, with no app
animating.

- With a booted device and no viewer, the hub costs nothing until something opens a stream:
  0.03% (Bun) and 0.15% (`polaris`). Opening one starts capture at **~2% of one core, which
  stays until the hub stops or the device shuts down**, viewer or not.
- An AVCC viewer adds almost nothing (2.1%). An MJPEG viewer costs ~10% and ~11 Mbit/s, so
  the Desktop App and remote Clients should use AVCC.
- After the session closes (hub stopped), the cost is zero. A restarted hub is back at 0.03–0.15%.
- RSS: 50 MB idle, 70–160 MB with capture (the MJPEG viewer pushed it to 158 MB).

Script: `/tmp/spikeS/scripts/cpu.sh <pid> <seconds>` (not committed). It sums `ps -o time=` over
`pgrep -P` descendants before and after `sleep <seconds>`.

## agent-device

Against the Duo, with the hub streaming the same device at the same time:

```sh
AD="bun /tmp/spikeS/hub/node_modules/agent-device/bin/agent-device.mjs"   # or BUN_BE_BUN=1 polaris …
$AD open com.apple.Preferences --platform ios --udid <UDID> --foreground
$AD snapshot -i --udid <UDID>
$AD press 'label="About"' --settle --udid <UDID>
$AD screenshot out.png --udid <UDID>
$AD close --udid <UDID>
$AD daemon stop
```

| Step | Time |
|---|---|
| First `open`, including the XCUITest runner build ("Building Apple runner...") and launch | **46.9 s** |
| `open` with the runner cached (new daemon) | 4.4–5.3 s |
| `snapshot -i` | 0.26–0.30 s |
| `press … --settle` (acts, waits for quiet, prints the UI diff) | 2.7–6.1 s |
| `screenshot` (466×678 @1x on the Duo's outer panel) | 2.4 s |
| `close`, `daemon stop` | 1.0 s, 0.3 s |

- **Cache:** `~/.agent-device/apple-runner/derived/ios-simulator/cache-<hash>/` (7 MB: the
  `.xctestrun` and `Debug-iphonesimulator` products for `iphonesimulator27.2-arm64`), plus
  `~/.agent-device/snapshot-source/<hash>/snapshot-bridge` (a helper spawned into the Simulator
  with `simctl spawn`). `AGENT_DEVICE_HOME` did **not** move it (sessions and cache still went to
  `~/.agent-device`); `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` exists for the derived path. The
  hash keys on the runner source and Xcode, so an Xcode update rebuilds it.
- **Processes:** a daemon (`<runtime> …/dist/src/internal/daemon.js`, spawned with
  `process.execPath`, so it is Bun or `polaris`), an `xcodebuild test-without-building`, the
  runner app inside the Simulator (~300 MB RSS) and `snapshot-bridge`. After `close` the runner
  stays warm by design (it self-idles after 5 min): together ~2.3% CPU (daemon tree 1.25%, runner
  app 1.05%). `agent-device daemon stop` ends all of them gracefully; the Daemon should call it
  rather than kill the process.
- **Selectors:** `press 'label="General"'` failed with `AMBIGUOUS_MATCH` once Settings was already
  on General, because the reopened session kept the app's state. Agents should snapshot first; the
  errors are in `~/.agent-device/sessions/<session>/requests/<id>.ndjson`.
- **Duo:** agent-device has a `fold closed|half-open|open` command and documents that a pose change
  invalidates every ref and coordinate (`agent-device help foldable`).

## Android (serve-emu), from the code only

This Mac has no Android SDK, so nothing here ran. These notes are from reading the vendored dist code, with file:line references.

Paths: `E/` = `vendor/serve-emu/dist/`, `hub` = `dist/server/index.mjs`, `cli` = `dist/server/cli.mjs` (all under `node_modules/expo-device-hub/`). Read-only review of the dist JS; nothing was run. "Inferred" marks conclusions the code does not state directly.

### Android: 1. What the Host needs

**Android SDK discovery** (`E/android-sdk.js:24-92`). The candidate roots, in order:
1. `ANDROID_HOME`, then `ANDROID_SDK_ROOT`.
2. The SDK that holds an `adb` or `emulator` found on PATH, after realpath. The binary's parent folder must be `platform-tools` or `emulator` (`:49-69`).
3. The defaults: macOS `~/Library/Android/sdk`; Windows `%LOCALAPPDATA%\Android\Sdk`; Linux `~/Android/Sdk` and `~/Android/sdk` (`:77-92`).

The hub has its own copy for listing and booting devices, and resolves an absolute `platform-tools/adb` path (`hub:9495-9530`).

**Binaries**
- `adb`: serve-emu always runs the bare name `"adb"`, so it must be on PATH. See `E/adb.js:15,47,75…`, `E/scrcpy.js:73,81`, `E/emulator-grpc.js:161,206`, `E/logcat.js:63,101`. The SDK lookup is not applied to adb inside serve-emu (inferred: streaming fails if adb is not on PATH, even when ANDROID_HOME is set).
- `emulator`: an explicit path, else `emulator -version` on PATH, else `<root>/emulator/emulator` or `<root>/tools/emulator` (`E/emulator.js:36-75`). It is only needed for `/api/avds/start` and `/api/avds/stop`. The launch args are `@avd -port N -no-metrics [-gpu X] [camera args]` (`E/emulator.js:238-254`). Stopping a device runs `adb emu kill` and then SIGTERM (`:259-268`).
- `aapt2` from SDK build-tools, only for app icons (`E/apk-icon.js:154-188`).
- **scrcpy-server v4.0** is not bundled in this install: `vendor/serve-emu/vendor/` is absent, although `package.json` "files" lists it. On first use, `ensureScrcpyServer()` downloads it from GitHub releases into `vendor/serve-emu/vendor/scrcpy-server-v4.0` (`E/scrcpy-server.js:8-26`), so the first run needs network access and a writable `node_modules`.
  - It is pushed to `/data/local/tmp/serve-emu-scrcpy-server-v4.0.jar-<hash>` (`E/scrcpy.js:9,673-684`).
  - The connection uses `adb forward tcp:N localabstract:scrcpy_<scid>` (`:174-207,591`).
  - It runs as `adb shell CLASSPATH=… app_process / com.genymobile.scrcpy.Server 4.0 scid=… audio=false video=… tunnel_forward=true control=true …` (`:686-700`).

**ffmpeg** is only needed for the `grpc-screenshot` source, which is the hub's default for emulators (see below). It is the user's ffmpeg, not a bundled one: the binary is `SERVE_EMU_FFMPEG` or `ffmpeg` on PATH (`E/h264-encoder.js:345-347`).
- **Software probe:** `ffmpeg -hide_banner -encoders`. It must list `libx264`, otherwise the error is "does not include the libx264 encoder" (`:355-383`). Failures are not cached, so the probe is retried.
- **Hardware probe** (`encoder: "hardware"`): the candidates are `h264_videotoolbox` on darwin, and `h264_nvenc` then `h264_vaapi` on linux. `SERVE_EMU_HARDWARE_ENCODER` can pin `videotoolbox`, `nvenc` or `vaapi`. Each candidate gets a 256×256 smoke encode, and the output must contain SPS, PPS, IDR and at least 2 AUDs (`:390-530`). VAAPI uses the device `SERVE_EMU_VAAPI_DEVICE`, default `/dev/dri/renderD128`, and checks it for R/W access (`:155-157,489-495`).
- **Spawn** (`:649-655`) is `ffmpeg <args>` with stdin = RGB24 frames or PNGs, and stdout = Annex-B H.264. The args come from `ffmpegEncoderArgs` (`:158-200`):
  ```
  -hide_banner -loglevel error
  [vaapi: -init_hw_device vaapi=va:<dev> -filter_hw_device va]
  input rgb24: -f rawvideo -pix_fmt rgb24 -video_size WxH -framerate F -i pipe:0
  input png:   -probesize 32 -analyzeduration 0 -max_probe_packets 1 -f image2pipe -framerate F -c:v png -i pipe:0
  -an -vf crop=trunc(iw/2)*2:trunc(ih/2)*2[,transpose=cclock|hflip,vflip|transpose=clock][,format=nv12,hwupload for vaapi]
  libx264:      -pix_fmt yuv420p -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline
                -b:v B -maxrate B -bufsize B -x264-params keyint=K:min-keyint=K:scenecut=0:repeat-headers=1:aud=1
  videotoolbox: -pix_fmt nv12 -c:v h264_videotoolbox -allow_sw 0 -realtime 1 -flags +low_delay -profile:v baseline <rate> -g K -bf 0 -bsf:v h264_metadata=aud=insert
  nvenc:        -pix_fmt nv12 -c:v h264_nvenc -preset p1 -tune ull -zerolatency 1 -delay 0 -bf 0 -rc-lookahead 0 -rc cbr <rate> -g K -forced-idr 1 -aud 1 -profile:v baseline
  vaapi:        -c:v h264_vaapi -rc_mode CBR <rate> -g K -bf 0 -async_depth 1 -profile:v constrained_baseline -bsf:v h264_metadata=aud=insert
  -f h264 -flush_packets 1 pipe:1
  ```
  K = round(fps × keyFrameInterval), or 250 when the interval is 0. Closing ffmpeg ends stdin, waits 250 ms, sends SIGTERM, waits 500 ms, then sends SIGKILL (`:723-760`).
- **Hub defaults** (`hub:11836-11846,11886-11894`): `maxFps 60`, `streamMode "grpc-screenshot"`, `grpcImageMode "rgb888"` (serve-emu's own default is `png`, `E/shared/api-contracts.js:37`), `encoder "software"`, `streamSettings.transport "websocket"`. They can be overridden with the `EXPO_DEVICE_HUB_SERVE_EMU_OPTIONS` JSON. Physical devices always use `scrcpy` (`E/middleware.js:2048`).
- In `grpc-screenshot` mode the default input source is still `scrcpy` (`E/shared/api-contracts.js:27`). The gRPC session then also starts a scrcpy control-only server, with `video=false` (`E/grpc-session.js:1270`). Inferred: the default emulator path needs ffmpeg with libx264 and the scrcpy jar.

**KVM / platform checks.** Nothing references `/dev/kvm`, `kvm` or `-accel` in serve-emu (grep of `E/*.js`). The only platform branches are:
- SDK default paths and `.exe` names.
- The hardware-encoder candidates by `process.platform`.
- The VAAPI device check.
- The emulator discovery dirs.

Inferred: KVM problems would only show up as emulator boot failures.

**node-datachannel (WebRTC).** It is loaded lazily with `createRequire(import.meta.url)("node-datachannel")` in `createWebRtcPublisher` (`E/webrtc-publisher.js:1-3,154-162`). It is only loaded when `/webrtc/offer` is called. The hub lists `node-datachannel ^0.33.4` as a dependency and in `trustedDependencies`, because it is a native addon with a postinstall step. The default transport is websocket (`E/stream-settings.js:23-25`), so it is not needed for the default path. Offers must be H.264 only, and the client may not supply ICE servers (`E/webrtc-signaling.js:19-40`).

**gRPC to the emulator** (`E/emulator-grpc.js`):
- **Discovery:** it reads `pid_<pid>[_info].ini` from:
  - `~/Library/Caches/TemporaryItems/avd/running`
  - `$TMPDIR/avd/running`
  - `~/.android/avd/running`
  - `$XDG_RUNTIME_DIR/avd/running`
  - `%LOCALAPPDATA%\Temp\avd\running`

  It skips dead PIDs (`kill(pid,0)`), matches `port.serial` to the console port in `emulator-NNNN`, and takes `grpc.port`, `grpc.token` and `avd.name`; the newest mtime wins (`:23-101`).
- **Fallback:** if the discovered port is not reachable on 127.0.0.1, it allocates a free port, runs `adb -s <serial> emu grpc <port>`, and polls discovery 40 × 50 ms. At most 5 attempts are made. If the endpoint has no token it warns and connects unauthenticated (`:179-242`).
- **Transport:** raw `node:http2` to `http://127.0.0.1:<port>` with an 8 MiB window and hand-rolled protobuf. Requests go to `POST /android.emulation.control.EmulatorController/<method>` with `authorization: Bearer <grpc.token>` when a token exists (`:729-770`).
- **Methods used:** `getScreenshot`, `streamScreenshot`, `sendTouch`, `sendKey` (`:906-969`).
- **Image modes:** `png`, `rgb888`, and `mmap`. In `mmap` mode the client creates a temp file region, the emulator writes into it, and serve-emu reads it with `readSync`, twice per frame, to detect tearing. No native mmap is used (`E/grpc-mmap.js:63-110`).

### Android: 2. HTTP and WebSocket surface (as mounted in the hub)

The hub strips `/vendor/serve-emu` (relative to its mount, default `/_expo/plugins/expo-device-hub`; the CLI sets the base path to `""`, `cli:1355`) and forwards the request to `router.handleRequest` (`hub:11963,11994-12003`). The router uses Fetch `Request`/`Response` throughout. Every device-scoped route takes `?device=<serial>`, which defaults to the selected device or else the first online one (`E/middleware.js:2024-2047`). If that device can't be resolved or started, the route returns 503 `{ok:false,error}` (`:2679-2689`).

**Auth.** There are two gates.
- **Hub gate:** with `EXPO_DEVICE_HUB_SESSION_TOKEN` (or `--require-token`, which generates `randomBytes(32).base64url`, `cli:1382`), the hub gate `authorizeRequest` accepts Bearer or `?token=`. It then re-adds the token as `Authorization: Bearer` before forwarding (`hub:12569-12583`).
- **Router gate** (`E/session-token.js`):
  - HTTP: `Authorization: Bearer <t>` or `?token=<t>` (`:36-40`).
  - WebSocket upgrade: Bearer, or the subprotocol `serve-emu.token.<t>` (`SESSION_TOKEN_SUBPROTOCOL_PREFIX`, `:9`), with at most 4 offered entries compared. `?token=` is never accepted on an upgrade (`:45-48`).
  - Comparison is constant-time. The token alphabet is `[A-Za-z0-9._~-]`.
  - A refusal is a 401 with `{ok:false,error:{code:"unauthorized",…}}` and `WWW-Authenticate: Bearer` (`:53-60`).
  - OPTIONS preflights bypass the gate (`E/middleware.js:2389`).
  - Non-GET requests from a disallowed browser Origin get a 403 `forbidden` (`:2396-2407`).

**Router-level routes** (`E/middleware.js:2384-2660`):
- `GET /api/devices` returns `{ok, defaultSerial, devices:[{serial,…,streaming}]}` (`:2280-2295`). It does not start capture.
- `GET|PUT /api/stream-mode`:
  - PUT body: `{mode:"scrcpy"|"grpc-screenshot", encoder?:"software"|"hardware", grpcImageMode?:"png"|"mmap"|"rgb888", inputSource?:"scrcpy"|"grpc"}` (`E/shared/api-contracts.js:306-335`).
  - Response: `{ok, serial, mode, repeatFrameMs, grpcImageMode, encoder, encoderName, availableEncoders, hardwareEncoderError?, inputSource, availableInputSources, availableModes, sessionGeneration}` (`E/middleware.js:2296-2318`).
  - GET starts the device app if needed.
- `PATCH /api/stream-settings` (also `GET` per app, `:876-940`): patch fields `maxDimension`, `h264Bitrate`, `h264Fps`. It restarts capture.
- `GET /api/device-grid`, `POST /api/devices/select`.
- `POST /api/avds/start` `{avd,…}`.
- `POST /api/avds/stop` `{serial}|{avd}`: stops the app, then kills the emulator (`:2599-2640`).
- `/webrtc/stats` (observational; never starts capture).
- Camera routes.
- Any non-API path serves the static UI without touching a device (`:2666-2671`).

**Per-device app routes** (`E/middleware.js:871+`, `E/api/routes/*.js`; JSON errors use the `API_ERROR_CODES` list in `E/shared/api-contracts.js:3-16`):
- `GET /api` returns `{generation, serial, device, streamMode, grpcImageMode, encoder, encoderName, inputSource, codec, size:{width,height}, pose, status, lastFrameAt, lastError, clients, stream, screenRecording, viewerTransports}` (`:945-973`).
- `GET /health` returns a large diagnostics object: `ok, status, size, frames, sourceFps, droppedFrames, clientsDetail, …`. The status is 200 while streaming, otherwise 503 (`:260-300,1218-1222`).
- `POST /webrtc/offer`:
  - Body: `{type:"offer", sdp, sessionId:<uuid>, codec?:"h264"}`.
  - Response: the answer JSON (`:1223-1261`).
  - `POST /webrtc/close` takes `{sessionId}` and returns 204.
- **Input** (`E/api/routes/input.js`), each returning `{ok:true}`:
  - `POST /api/tap` `{x,y}`, with coordinates normalised 0..1.
  - `POST /api/swipe` `{x1,y1,x2,y2,durationMs?≤10000}`.
  - `POST /api/text` `{text}`.
  - `POST /api/key` `{key:"back"|"home"|"recents"|"power"}` or `{keycode,action?:"down"|"up",metaState?}`.

  The gesture schema is in `E/shared/control-contracts.js:49-105`.
- **Inspection** (`E/api/routes/inspection.js`):
  - `POST /api/screenshot` returns `image/png` (GET gets 405 before the device starts, `E/middleware.js:2673`).
  - `GET /api/logcat`, `/api/metrics`, `/api/foreground`, `/api/accessibility`, `POST /api/accessibility/tap`.
- **Session recording** (`E/api/routes/session.js`; paging via `limit≤200`, `before` in `E/session-api.js:13-26`):
  - `GET /api/session` and `DELETE /api/session` (clears the recorded input session).
  - `POST /api/session/replay {multiplier}` and `POST /api/session/replay/stop`.
- **Device state and apps** (`E/api/routes/devices.js`, `applications.js`, `location.js`):
  - GET/POST pairs for orientation, fold, night-mode, font-scale, network, reduce-motion, high-text-contrast, font-weight, software-keyboard and display-density.
  - Apps: install, launch, clear, force-stop, grant, revoke, reset-permissions, permissions, icon; `POST /api/files/import`.
  - Location: `GET|POST /api/location` and `GET|POST /api/route`.

**WebSocket** (`hub:12687-12692`, `12004-12027`). The route is `<mount>/vendor/serve-emu/ws`.
- **Query:** `device=<serial>`, `video=0` (input only), `frame-meta=1` (`hub:11927-11933`).
- **Auth:** checked twice, by the hub's `gatedSocket` and again by `router.authorizeUpgrade` / `attachWebSocket` (`E/middleware.js:2696-2717`).
- **Startup:** the hub awaits `router.ensure(device)`, which starts capture before attaching.
- **Close codes** (`:1736-1744,1760,628-633,1806`): 1013 if the session is not streaming; 1008 `stream_transport_locked` when the transport is webrtc; 1009 if a message is over 16 KiB; 1013 "client too slow"; 1001 when the server stops.
- **Server → client, binary.** There is one H.264 Annex-B access unit per message. The cached SPS+PPS is prepended to every keyframe (`E/middleware.js:645-709,381-387`). A new client receives nothing until a keyframe (`awaitingKeyFrame`).
  - Backpressure: if `bufferedAmount` is over 512 KiB, frames are dropped until the next keyframe; over 16 MiB, the client is closed (`:49-50,627-642`).
  - With `frame-meta=1`, a **16-byte v1 header** precedes the payload: `u32 BE magic 0x53454D55 "SEMU" | u8 version=1 | u8 flags (bit0 = keyframe) | u16 0 | u64 BE pts µs` (`E/middleware.js:51-54,369-380`).
  - `E/shared/frame-meta.js:7-30` also defines a 24-byte v2 header (adding `u64` server epoch µs), but the router path writes v1. Inferred: v2 is used by the standalone `server.js` only.
- **Server → client, text:**
  - `{"type":"video-session","size":{"width","height"}}` on a resolution or source change (`:675-681,758-764`).
  - Acks `{"ok":true}` / `{"ok":false,"error":"…"}` (`E/shared/websocket-contracts.js:52-77`).
- **Client → server, text JSON only** (binary is ignored, `E/stream-socket.js:43-46`):
  - Any gesture from `parseGesture`: `tap`, `swipe`, `touch` `{action:"down"|"move"|"up",x,y,pointerId?}`, `key`, `text`, `back`, `home`, `recents`, `power`.
  - Or `{"type":"reset-video"}` to request a keyframe.
  - Optional `ack:false` suppresses the reply (the default is to ack) and `record:bool` (`E/middleware.js:388-392,1758-1789`).

### Android: 3. Session lifecycle

**Start**
- `router.ensure(device)` calls `resolveSerial` (`adb devices`), then `getApp`/`getAppUnqueued` (`E/middleware.js:2243-2249,2081-2129`). Calls for the same device share one in-flight start. A failed start blocks retries for that device for 5 s (`SPAWN_RETRY_COOLDOWN_MS`, `:63,2090`).
- `createApp` then calls `startEmuSession` (`E/stream-session.js:12-28`), which takes one of two paths:
  - **scrcpy:** it buffers output until SPS, PPS and an IDR arrive, with a 10 s limit (`:32-72`).
  - **grpc:** endpoint discovery, encoder resolution, the first image within 10 s, and ffmpeg (`E/grpc-session.js:27,1196+,1840-1849`).
- Any HTTP request to `/api/*`, `/health` or `/webrtc/*`, and any WS attach, implicitly starts capture. `/api/devices` and `/webrtc/stats` don't.

**No idle stop.** Nothing stops capture when the last client leaves: WS close only removes the client (`E/middleware.js:1790-1793`), and no timer checks `clients.size`. The app's only `watchdog` interval is a 1 s FPS sampler (`:856-864`). `SessionRecoveryWatchdog` (`E/session-recovery-watchdog.js`) is used only by the standalone `E/server.js:34,833`, not by the router.

In grpc mode an `idleTimer` re-sends the last frame every `repeatFrameMs`, 500 ms by default, while capture is idle (`E/grpc-session.js:25,1845-1849`). Inferred: ffmpeg keeps encoding about 2 frames/s even with no viewers.

**Stop**
- **Per device:** `stopApp(serial)` (`E/middleware.js:2336-2360`) is internal to the router. Its only HTTP caller is `POST /api/avds/stop`, which then also kills the emulator (`:2617-2620`). Stream-mode switches and settings changes replace the session.
- **Inside an app,** `app.stop()` (`:1796-1824`) does the following without killing the process:
  - closes WS clients with 1001;
  - closes the WebRTC publisher;
  - clears the timers;
  - `session.close()`: for scrcpy this closes the control and video sockets, the adb shell child and the forwards; for grpc it ends ffmpeg (stdin end, then SIGTERM, then SIGKILL), closes the scrcpy control, the http2 client and the mmap region (`E/grpc-session.js:1660-1701`);
  - releases device state.
- **Router-wide:** `router.stopAll()` (`E/middleware.js:2718-2757`) aborts all operations, stops every app and awaits pending starts. It sets `stopped = true` permanently, so the router rejects every later `ensure` ("serve-emu router is stopped", `:2082`). Inferred: to stop capture and start it again in the same process, either the embedder creates a new router, or it uses `/api/avds/stop` (which kills the emulator), or a stream-mode PUT replaces the session.
- **Hub wiring:** the hub calls `stopAll` from `AndroidSession.shutdown()` on SIGINT/SIGTERM and on `process.exit` (`hub:11767-11774,11986-11993`).

### Android: 4. Bun versus Node (hypotheses only)

serve-emu is written for Bun. The standalone server uses `Bun.serve`, `Bun.file` and `Bun.argv` (`E/server.js:113,2266`, `E/cli.js:15`). There is a Bun-specific workaround for child stdin `writableNeedDrain` (`E/h264-encoder.js:711-715`). The hub's own `cli` script is `bun dist/server/cli.mjs`, although the `cli.mjs` shebang is `node`. So the router itself (Fetch Request/Response plus `node:` modules) is expected to run on both runtimes.

Plausible friction under Bun:
- **`node:http2` client** with `setLocalWindowSize` and custom `initialWindowSize` (`E/emulator-grpc.js:729-737`). Bun's http2 client is the least mature `node:` module, so gRPC screenshot streaming is the riskiest part (inferred).
- **`node-datachannel`** is a native addon loaded through `createRequire` (`E/webrtc-publisher.js:156`). It needs Bun's N-API support and the postinstall-built binary (`trustedDependencies`). It is only loaded on the WebRTC path.
- **The `ws` package with `node:http` upgrade** in the hub CLI (`cli:7-9,1429-1440`). Bun polyfills both; `fromWsSocket` relies on `ws.bufferedAmount` for backpressure (`E/stream-socket.js:31-52`). Inferred: this could behave differently under Bun.
- Lower risk, all of which Bun implements:
  - `child_process.spawn` with piped stdin and backpressure (ffmpeg, adb);
  - `process.kill(pid, 0)` for liveness (`E/emulator-grpc.js:42`);
  - `fs.readSync` positional reads for mmap;
  - `crypto.timingSafeEqual`;
  - `stream/promises`;
  - `node:net` `createConnection` / `createServer`.

## Surprises

1. **`xcrun simctl` ran `xcodebuild -runFirstLaunch`** on its first call after an Xcode update
   (Xcode 27.2, 27B52 here). It took ~6 min, printed "Install Started … Install Succeeded",
   and blocked every simctl call meanwhile, the hub's included. Free disk fell from 8.9 GB to
   6.7 GB while it ran and recovered afterwards. The Daemon should detect this (a `simctl` that
   hasn't answered and an `xcodebuild -runFirstLaunch` child) and say "Xcode is finishing an
   update" rather than time out silently.
2. **Capture never idles out.** One stream request leaves capture running at ~2% CPU with no
   viewers. The only ways to stop it are stopping the hub or shutting the device down.
3. **The token can't be chosen.** `--require-token` makes its own; read it from the state file.
4. **The preview page spawns a detached helper** (`GET /vendor/serve-sim/`) that outlives the hub.
5. **`/grid/api/start` takes `udid`, not `device`.**
6. **`/metrics` is SSE.**
7. **The first MJPEG frame is stale** (the last cached frame).
8. **A still screen still streams ~4.5 fps** of AVCC deltas, so "no new frame" can't mean zero
   frames.
9. **A tap needs begin and end close together** (~60 ms); 1.2 s apart is a long press.
10. **`simctl io screenshot` fails on the iPhone Duo** (`Invalid argument`).
11. **The Duo boots on its outer panel** (466×678 pt); agent-device's screenshot and refs are in
    that panel's space until a fold.
12. **`/api/devices` always carries an Android error** on a Mac without the SDK, as an object with
    a stack trace containing local paths.
13. **`AGENT_DEVICE_HOME` didn't move agent-device's state**; it stays in `~/.agent-device`.
14. **serve-sim leaves per-device files in `$TMPDIR/serve-sim/`** after a SIGTERM, one of them
    holding the dead hub's token.
15. The auto-mode classifier refused `kill -TERM` on agent-device's daemon from this agent;
    `agent-device daemon stop` did it gracefully, and is the right interface anyway.

## Follow-ups for the other Tasks

- Daemon installer: install the two npm tarballs and five dependencies (a pinned `bun install`
  with a lockfile, or one prebuilt archive with a hash), not a single binary. Run both tools with
  `BUN_BE_BUN=1 <polaris>`; no Node.
- Daemon supervisor: start the hub with `--host 127.0.0.1 --port <free> --require-token` and a
  private `EXPO_DEVICE_HUB_STATE_DIR` and `TMPDIR`. Read the token from the state file. Stop it
  with SIGTERM (allow 60 s) when no Agent Session shows a Simulator. Never load
  `/vendor/serve-sim/`.
- Desktop App: decode `stream.avcc` with WebCodecs (tags above); drive `/ws` with
  `[tag][JSON]`, waiting for `0x83`, using `0x11`/`0x91` barriers for wedge detection.
- Remote Clients: forward the AVCC chunks as a byte stream (ADR 0093); never MJPEG.
