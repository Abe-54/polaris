# apps/mobile

The Mobile App (`@polaris/mobile`): Expo React Native on Hermes, sharing `@polaris/protocol`,
`@polaris/client` and `@polaris/sdk` with the other Clients (ADR 0081): Home, Hosts and the
constellation view, in midnight, over one `HostConnection` per Host.

## Run it in the iOS simulator

Needs Xcode with an iOS simulator runtime (`xcodebuild -downloadPlatform iOS`) and CocoaPods.

```sh
bun run --cwd apps/mobile dev:daemon   # a dev Daemon; prints the dev bridge line
EXPO_PUBLIC_POLARIS_DEV_BRIDGE='polaris-dev-bridge:v1:…' bun run --cwd apps/mobile ios
```

`ios` is `expo run:ios`: it writes `ios/` from `app.json` (Continuous Native Generation, not
committed), builds, installs, starts Metro and opens the app. CocoaPods needs a UTF-8 locale
(`export LANG=en_US.UTF-8`). Later runs only need `bun run --cwd apps/mobile start`.

`dev:daemon` runs `polaris serve` from source on a throwaway `POLARIS_HOME` with the scripted
bench Harness (the SDK's test Daemon), registers a Workspace and starts two agent sessions. A
prompt such as `bench:{"approvalEvery":1,"approvalQuestion":{"question":"…","choices":["A","B"]}}`
makes a session ask for approval or answer, to try Home's inline replies.

## Hosts and the dev bridge

The app is a Client, not an Extension: every screen shares one `HostConnection` per Host
(`src/runtime/hostConnection.ts`), a `DaemonRpcs` client over a pluggable byte transport with
`@polaris/client`'s Connection State machine. `src/runtime/hosts.tsx` provides them to React
(`HostsProvider`, `useHosts`, `useHost`, `useHostStatus`, `useLiveHost`, `useHostRegistry`).
Release builds reach Hosts through the Polaris Relay; development builds also have the dev bridge.

`dev:daemon` starts the dev bridge (`scripts/devBridge.ts`): a WebSocket on 127.0.0.1 that
forwards each connection to the Daemon's Unix socket, so the simulator gets a Client's power. It
requires the random token the script prints and admits only its own Host and Origin (the one iOS
derives from the URL; the bridge serves no pages), so a web page can't reach it. Start Metro with the line it prints:

```sh
EXPO_PUBLIC_POLARIS_DEV_BRIDGE='polaris-dev-bridge:v1:…' bun run --cwd apps/mobile start
```

Only `__DEV__` builds read the variable; the bridge itself is a script and never bundled.

## Home and Hosts

`src/home/` is Paper H4. `feed/` follows each Host's feed (`openHostFeed` over its
`HostConnection`, so a Host offline at launch is followed once it connects) and folds it
(`fold.ts`); `model/` turns the folded Hosts into Home's sections, lines and replies; `ui/` draws
them. An approval whose command runs past four lines is answered in the agent session, never
inline. `scripts/home.daemon.slow.test.ts` approves, denies and answers against a real Daemon.
`src/hosts/` is Paper M7: each Host's Connection State and route, read only.

The shell is `src/App.tsx` with `src/app/` (navigation, tab bar, back bar). `src/app/routes.tsx`
holds the routes for the thread, Review, New agent session and Link screens.

## Long-press menus

`src/menus/` gives Home's rows, the Review tab's rows and Hosts the Desktop App's right-click
items (ENG-490): `model.ts` decides which items a row offers in which state, and every command one
sends must be granted to a linked device (`DEVICE_COMMANDS`; the test checks it). The menu is
native: `modules/polaris-context-menu` is a local Expo view with a `UIContextMenuInteraction`
that lifts the row as its preview, and the pasteboard for the Copy items. It is a native module:
rebuild the development client (`bun run --cwd apps/mobile ios`); a build without it draws the
rows with no menu.

## New agent session (MX-AO)

`src/newSession/` is New: a blank thread (`NewSessionScreen`, the `newSession` route) headed "New
session" over the horizon, whose first send creates the session. It reads Home's followed feeds
(`useFollowedHosts`) and calls the Host's `DaemonRpcs` through its `HostConnection`, following the
Desktop App's new-session rules: the last used workspace with its Host, the most recently used ready
Harness and that Harness's last Model, the Models' shortlist, in place unless New worktree is on (a
branch from the prompt and the session's id). The composer's place line opens the workspace sheet
(MX-AQ: workspaces by Host, Connection State and round trip, New worktree); the model chip opens the
composer's model sheet. With no Harness ready the setup panel takes the sky (MX-AR). Drafts stay on
the phone, one per Host and Workspace, until the send. Once started, the thread replaces the screen
and the celestial rises into its header (MX-AS; `src/thread/Rise.tsx`). Plan first starts in `plan`
where the Host announces `session.plan-mode`, and sends `supervised` where it doesn't
(`permissionModeFor`, ENG-466). `scripts/newSession.test.ts` starts a real session on a test Daemon
through the dev bridge. `-polarisDevNewSession <ao|aq|ar|as>` (with `-polarisDevTheme`, and
`-polarisDevSlowRise 10` to slow the rise) opens the states from fixtures in a development build.

## Attach and the mic

`src/composer/` is shared by the thread's composer (M4) and a new agent session (MX-AO); each
renders Attach and the mic only when given them, and they are given only where the Host announces
`attachments.stage` and `voice`. `useAttachments` picks a photo or file (expo-image-picker,
expo-document-picker), stages it at once with `attachments.stage`, the bytes sent as a Wire blob,
and shows a chip; Send and Start carry the staged ids. A steer is text only, so a draft with
attachments during a Turn waits as a follow-up. Pasting images into either composer's field
(the edit menu's Paste, or ⌘V) stages them the same way: `modules/polaris-paste` extends React
Native's text views so Paste is offered for an image alone in a field `usePastedImages` watches
(its `nativeID`), writes each as PNG or JPEG to the caches directory and reports them; any text
pastes as before. `useVoiceInput` records 16 kHz s16le mono PCM
(expo-audio's `useAudioStream`; `pcm.ts` mixes down and resamples when the phone gives another
format), streams it to `voice.transcribe`, and writes what the Host hears after what was typed. A
Host without a key says so in the composer with its own message. These are native modules: after
pulling them in, rebuild the development client (`bun run --cwd apps/mobile ios`).
`scripts/composer.test.ts` stages, starts with an attachment and dictates against a real Daemon.

## The constellation view

`src/constellation/` is Paper C2: `ConstellationScreen({ hostId, constellationId, onBack? })` follows `constellation.subscribe` and re-reads `constellation.status` on each event; `model.ts` folds it into the lead row, the task bar and the rail (finished groups fold; a parent task has no row of its own). Accept approves the claim (`constellation.review`) and then messages the lead; Send back only messages the lead, who sends it back (`verdict.ts`). `scripts/verdict.test.ts` checks both against a real Daemon over the dev bridge.

## Widgets

Paper MX-AW and MX-AX: the inline lock-screen widget ("✦ 2 need you · 3 working" beside the
date) and the medium home-screen widget (Home's top three agent sessions with their glyphs, and
the horizon), in the app's theme. They are
WidgetKit in Swift (ADR 0081) under `targets/widgets/`, a target `@bacons/apple-targets` (a
devDependency, its config plugin only) adds to the Xcode project at prebuild.

- **Data.** `src/widgets/snapshot.ts` turns an unfiltered Home into the snapshot: the summary
  parts, three rows with their deep links, the empty line and whether every Host is offline.
  `WidgetSync` (mounted under `FollowedHostsProvider`, so the feeds outlive Home) rebuilds it on
  every feed change; `publish.ts` writes it, with `writtenAt`, as JSON to the App Group
  `group.dev.lux.polaris` under `polaris.widgets.snapshot` through the local Expo module
  `modules/polaris-widgets`, and reloads the timelines only when it changed. Until a Host has
  been reached this launch the last snapshot stays.
- **Pushes (R5).** The Notification Service Extension writes opened pushes to the same App Group
  (`polaris.push.recent`) and reloads the timelines. `targets/widgets/Snapshot.swift` counts and
  lists a needs you push newer than the snapshot's `writtenAt` until the app writes again.
  `refreshWidgets()` in `src/widgets/WidgetSync.ts` reloads them from JavaScript after a wake.
- **Links.** `polaris://home` opens Home; `polaris://session/<hostId>/<sessionId>` opens the
  agent session (`src/widgets/links.ts`, handled by `useWidgetLinks`). W2's rows each link to
  their agent session, the rest of the widget to Home; W1 opens Home.
- **Checks.** `scripts/widgets.swift.slow.test.ts` compiles `Snapshot.swift` with `swiftc` and feeds
  it the app's real snapshot, so the Swift reader, its merge of pushes, its ages and its links
  can't drift from the TypeScript (skipped where there is no `swiftc`).
  `scripts/widgets.render.slow.test.ts` draws W2 on macOS through `scripts/widgetsDriver/render.swift`
  and checks it takes each theme's colours; `render.swift <midnight|moonlit> <out.png>` saves a
  render to look at. That one, `widgets.live.slow.test.ts` and `widgets.theme.test.ts`'s Swift run need
  Apple's frameworks (SwiftUI, CryptoKit, `os`), so they run only on macOS; Linux CI runs the rest.

## The Live Activity and Dynamic Island

Paper MX-AZ and MX-BA, decided in ADR 0088: one aggregate activity for every followed Host. It
lives in the widgets extension (`targets/widgets/Live*.swift`); the app half is the local Expo
module `modules/polaris-live-activity` and `src/live/`.

- **Content.** Each Host's slice (`HostSlice` in `@polaris/protocol/relay`) is sealed to this
  device's push key; the extension opens them with the key from the shared Keychain group and
  folds them (`LiveSlices.swift`). A slice it can't open shows "Open Polaris to see every host".
- **In front.** `useLiveActivity` (mounted with `usePush`) builds each Host's slice from its feed
  (`src/live/content.ts`, cut to fit as the Daemon cuts) and the module seals them. It starts the
  activity when anything works or waits on the user, updates it at most every 2 s, and ends it
  once every Host has been idle 10 minutes.
- **Suspended.** The activity's update token is registered with each linked Host
  (`devices.registerLiveActivity`, `src/live/registration.ts`); each Daemon pushes its slice
  through the Relay, which merges them into one liveactivity push. Unlink unregisters it.
- **Answers.** Approve, Always here and Deny are `LiveAnswerIntent`s (`LiveActivityIntent`, Face ID
  first). iOS runs the module's copy in the app; it hands the answer to JS (`takeAnswers`), which
  sends it as a notification action's answer, with the same command id (`src/live/answer.ts`).
  A question opens its agent session.
- **Looks.** The lock screen follows the app's theme (`Theme.swift`); the island is system black
  in Midnight's text colours. The celestials are generated: `bun scripts/liveCelestials.ts`.
- **Checks.** `scripts/widgets.live.slow.test.ts` folds the app's slices with `LiveSlices.swift` and
  checks the generated celestials. `bun scripts/liveRender.ts <simulator udid> <out dir>` renders
  every state in both themes to PNGs, for review without a lock screen.
- **Probe.** A Debug build launched with `-PolarisLiveActivityProbe` seals two Hosts' slices,
  starts the activity and takes it over, logging `POLARIS_LIVE …` (`log show --predicate
  'eventMessage CONTAINS "POLARIS_LIVE"'`); the extension logs each render the same way.

## Phase 3's shared pieces

- **The scan sheet.** `src/link/ScanSheet.tsx` is pairing's sheet (MX-AH, MX-AJ) and Link another
  Mac's (MX-AU): `ScanSheet({ open, title?, instruction, pasteInstruction, onClose?, onLink,
  onLinked?, onStep? })`, with `PAIRING_COPY` and `LINK_ANOTHER_COPY`. `onLink` is
  `useRelay().link`; `onStep` reports scan, paste, linking, linked and failed for a screen that
  lights its star by them. `src/link/linking.ts` is the step logic.
- **The states pattern.** `src/states/` (MX-AV): `StatePanel` for a top-level screen,
  `ReconnectingLine` above the composer, and `BubbleFootnote` with `useBubbleTreatment` for queued
  and failed sends. Launch a development build with
  `-polarisDevStates pair|another|empty|offline|review|thread` (and `-polarisDevTheme moonlit`).
- **Themes outside the app.** `WidgetSync` writes the theme's name to the App Group under
  `polaris.theme`; `targets/widgets/Theme.swift` reads it (`PolarisTheme.current`) and holds both
  palettes. `scripts/widgets.theme.test.ts` checks them against `@polaris/ui`'s tokens.

## Visualizations

`src/visualization/` draws the `visualize` Tool Call (ENG-599, ADR 0089, DESIGN.md Visualizations) as
a card in the thread, never folded into a run: `model.ts` reads the Daemon's `viz_…` id from the
call's output and finds the earlier ones a later call `replaces` (they collapse to "Revised below");
`VisualizationFrame` renders `@polaris/visualization`'s `buildFrameDocument` in a
`react-native-webview` WebView. The frame:

- loads only its own HTML string: `onShouldStartLoadWithRequest` lets `about:blank` through until
  the first load and refuses everything after, which shows the Stopped notice. `originWhitelist` is
  `["*"]` on purpose: a URL the whitelist fails is opened in Safari by the library without asking;
- has no file access, no cache, an incognito data store, WebRTC and `navigator.mediaDevices`
  removed in every frame before any script, and media capture denied;
- posts through `window.ReactNativeWebView` (the kit detects it); messages are schema-checked
  (`FrameMessage`): the height (clamped, inline at most 260pt under the 40pt title line), an https
  link opened only after the native action sheet, and `pv.state` kept in the document directory
  under `visualizations/<id>.json`. Theme changes go in as `pv:theme` through `injectJavaScript`.
- writes `pv.state` through `stateWriter.ts`: a state over 64 KB (UTF-8) is dropped, and writes
  land at most twice a second, the latest winning.

A frame nested in the fragment (even inside a closed shadow root) loads `about:srcdoc`, which the
policy refuses, so the card stops. `live.ts` caps live WebViews at three, the ones nearest the
screen; the others keep their height without a WebView. Expand opens an `InstrumentSheet` (RN's
`Modal` doesn't present here) with the frame at `mode: expanded`; the inline frame unmounts while
it is open and reads the saved state when it closes.

react-native-webview is a native module: rebuild the development client after pulling it in
(`bun run --cwd apps/mobile ios`); prebuild adds its pod, nothing else. The thread gallery's
Visuals data (`EXPO_PUBLIC_POLARIS_GALLERY=thread`, launched with `-polarisDevData visuals`) shows
the package's examples, a counter kept in `pv.state`, a revised one, one still drawing, an egress
probe that tries `fetch`, an image, WebRTC and navigating away, and a nested-frame probe.
`-polarisDevVisuals loan|revised|probe` ends the thread at that Turn.

## Markdown

`src/markdown/` draws agent messages as Markdown, as the Desktop App does with Streamdown: marked's
lexer (GFM), with remend closing what a stream left open (`**bol`, an unterminated fence), mapped to
`Text` and `View` in Midnight. Text only grows at its end, so the blocks before the last are kept and
only the open block is lexed again; a parse is cached by its text, so a finished message scrolled
back into view isn't parsed again. `MarkdownLine` is the few-line form (the lead's note). Links open
only for `http`, `https` and `mailto`; images show their alt text; HTML shows as written.

## Review

`src/review/` is Paper M5: `ReviewScreen({ hostId, sessionId, turnId?, colourblind?, onBack? })` reviews one agent session's Turn. It reads the Turn's diff (`git.diff`, as a blob), runs or reads its Risk Summary (`review.runRiskSummary`, then `review.watchRiskSummary`), and shows the Polaris summary with its tally, the files ordered by risk (or by path under Files), and findings inline under the line they flag. Accept sends `AcceptTurns` and is paused while a Critical finding is open. Send back sends the user's reply as a feedback Turn, and "Ask {harness} to fix" quotes the flagged lines. A Critical finding can't be hidden: a dismissed one stays listed, and its card stays visible when its file is closed.

The diff renderer is Pierre Diffs' patch parser on Hermes. Metro resolves `@pierre/diffs` to its DOM-free `parsePatchFiles` module only, about 13 KB, without Shiki or the DOM renderer. Rows are drawn by a React Native `FlatList`. There is no syntax colouring or word-level highlighting yet. `colourblind` switches to the `-cvd` diff pair.

The app is portrait: `expo-screen-orientation`'s plugin starts it locked to portrait, and the file
diff screen unlocks landscape while it is open (`src/diff/orientation.ts`), where it lays out MX-R's
before/after split. Adding the module needs a new native build or dev client.

The diff bench measures it on a device or simulator. It renders Review over a synthetic 2,000-line Turn and reports parse time and frame intervals on screen (and as `POLARIS_DIFF_BENCH {json}` in the log):

```sh
EXPO_PUBLIC_POLARIS_DIFF_BENCH=auto bunx expo run:ios --configuration Release   # JS-driven scroll at 5,000 pt/s
EXPO_PUBLIC_POLARIS_DIFF_BENCH=manual:2000 …                                    # 15 s of your own swipes
```

Home opens Review (the `review` route) from a session row that reads "Ready to review"; the bench replaces the app's root in `index.ts`.

## iPhone Duo

`modules/polaris-hinge` is a Swift Expo module over iOS 27.1's hinge API. It adds a
`UIHingeInteraction` to the key window (status and angle) and reads the window's `division`
reserved regions (the 40pt fold). It reports both as JSON, and `src/duo/posture.ts` parses that
into a posture:

- **Folded:** a closed hinge, no division, or before iOS 27.1. The iPhone app is unchanged.
- **Unfolded:** two halves either side of the division.
- **Half-folded:** partly open over a horizontal fold, a top half and a bottom half.

`DuoShell` (`src/duo/`) keeps the screen on top mounted in one place and only moves it, so
folding never navigates and the focus stays put. `arrangement.ts` decides what it draws:

- **D6:** an unfolded thread. The second half (`ContextPane`) follows the step, file or finding
  tapped in the first half, through the thread's optional `onFocus`/`focusedKey`. It reads the
  Turn's diff and the Risk Summary already on the Host, and never starts a review.
- **D9:** an unfolded constellation. The graph (`graph.ts`) spans both halves with no node on the
  division, and the lead sheet sits across the foot.
- **D7:** a half-folded thread is the laptop. `composerSlot` keeps the chips and composer below
  the fold.
- **D8:** half-folded Home is the monitor: sky, time and stars above the fold, and needs you as
  56pt targets below it, dimmed from 22:00 to 6:00. "Reply…" opens that session as the laptop.

`__DEV__` builds log each report as `POLARIS_POSTURE {json}`.

## Push

Needs You, finished Turns, agents' `notify` and a constellation needing you arrive as notifications (apps/daemon/src/push/README.md). The Daemon
seals each one to this device's push key with HPKE; the relay and the push service carry it
opaquely; the Notification Service Extension opens it.

- `modules/polaris-push`: a local Expo module. `pushKey()` makes the P-256 push key on first use
  and keeps it in the Keychain group `HWD6374DUX.dev.lux.polaris.shared`, which the extension
  shares (accessible after first unlock, this device only). `rotatePushKey()` replaces it;
  re-register afterwards. `apnsEnvironment()` reads the provisioning profile: sandbox for
  development builds and the simulator, production otherwise.
- `targets/notification-service`: the extension (@bacons/apple-targets). It opens the payload
  with CryptoKit (`P256_SHA256_AES_GCM_256`), sets title, subtitle, body, thread and category, and
  keeps the routing ids in `userInfo.polaris`. If it can't open it, the generic alert stays.
- `src/push`: `usePush(identity, linkedHosts)`, mounted in `App.tsx` with `useRelay()`'s keys and linked Hosts, sets the categories, registers with each linked
  Host as its connection comes live (`devices.registerPush`, again after a reconnect), and answers.
  The `approval` category has Approve, Always here and Deny; each needs Face ID or the passcode and
  doesn't open the app. The answer is a RespondToApproval with a command id per request, sent
  once the Host's connection is live, within a background task (about 30 s). `usePushLinks`
  (in `Shell`) opens what a tap points at: the constellation for one about a constellation
  (`constellationId` in `userInfo.polaris`), else the session.
- This iPhone's switches ride on each registration, and a change registers again (ENG-561):
  - per Host, on its details sheet (`src/push/hostNotifications.ts`, SecureStore
    `polaris.push.hosts-off`, on by default), as `notifications`: off, that Host sends this
    iPhone no pushes at all (Needs You, finished Turns, notifications and failures);
  - when a constellation needs you, for every Host, in Settings → Notifications
    (`src/push/constellations.ts`, SecureStore `polaris.push.constellations`, kept from when it
    sat on the Host sheet), as `automatic`: off, each Host stops sending Polaris's own
    constellation notifications here.

Unlinking this iPhone asks each Host to drop its registration (`devices.unregisterPush`, up to
3 s) before the connections close, and rotates the push key, so a Host that missed it can't be
read here.

### The widget hook

Each push the extension opens is added to the App Group `group.dev.lux.polaris`, UserDefaults
key `polaris.push.recent`: a JSON array, newest first, at most 20, of `{ kind, hostId, hostName,
sessionId, requestId, subtitle, at }` (no bodies). Then it calls
`WidgetCenter.shared.reloadAllTimelines()`; S7's `targets/widgets/Snapshot.swift` reads it (see
Widgets). After an answer from a notification is sent, the app calls `refreshWidgets()`.

### Try it in the simulator

`app.json` sets `aps-environment` to development; Xcode switches it to production when exporting
for TestFlight or the App Store. The simulator has no APNs token, but `xcrun simctl push` runs the
extension: seal a PushMessage to the key `pushKey()` returns (`sealPush` in
`apps/daemon/src/push/seal.ts`) and send
`{"aps":{"alert":{"title":"Polaris","body":"Open Polaris to see what changed."},"mutable-content":1},"p":"<sealed>"}`.

## Self-Traces

`src/selfTraces/` is the Mobile App's Tracer (ENG-713, ADR 0095), service `polaris-mobile`.
Developer Mode is read only here: `SelfTraceSync` (under `HostsProvider`) follows
`developerMode.watch` on each Host that announces `developer-mode` and `traces.self`, and points
the Tracer at the first Host, by id, whose mode is effective and that holds the Polaris
Workspace. With no such Host it is off: Spans are no-ops, commands carry no `traceparent`, the
buffer is empty and no timer runs.

- **Spans.** `mobile.connect` (transport and hello, with the route), `mobile.feed.subscribe`
  (each Home feed (re)subscription until its first item) and `mobile.dispatch.<Command>` (send,
  steer, start, approvals from Home and notifications). `tracer.traced` runs an Effect in a client
  Span; its RPCs carry the `traceparent` header and nested traced work becomes its child.
- **Buffer.** At most 1 MiB or 5 minutes of Spans, the oldest dropped first; every 5 s while on,
  batches that fit `traces.ingestSelf` go to the target Host. An unreachable Host keeps them;
  a refused batch is dropped. Turning off drops the buffer.

## The Hermes check

`src/runtime/selfCheck.ts` exercises Effect 4, the frame codec and pairing strings, the
Connection State machine, the resumable feed, the Markdown parser and the Self-Trace Tracer. The app runs it at startup in development, and
`bun run test` runs it on Hermes:

- `hermesc` (the `hermes-compiler` React Native ships) must compile the bundled check, always;
- the `hermes` VM runs it when one is built: `bun run --cwd apps/mobile hermes:build` (git,
  cmake and ninja) builds it from facebook/hermes at the release React Native's prebuilt
  `hermes-engine` uses, into `node_modules/.cache/hermes/<version>`.

`bun run --cwd apps/mobile hermes` runs the same check and prints each result.
`src/runtime/vmHost.ts` supplies the two things React Native adds over the bare VM that the check
needs: `console` and timers that honour their delay.

The app's own code runs on Bun in its tests, so those tests run without Hermes' gaps:
`src/runtime/hermesMissing.json` lists the builtin methods Bun has and the app's Hermes lacks
(`Array.prototype.toSorted` among them), and `bunfig.toml` preloads
`src/runtime/hermesBuiltins.preload.ts`, which deletes them, so a test that reaches one fails as the
app would. The list comes from the VM: `bun run hermes` fails when it is stale and `--write`
rewrites it. Run the tests from `apps/mobile` (`bun run --cwd apps/mobile test`); a `bun test` from
the repository root reads the root's `bunfig.toml` and keeps Bun's builtins.

## Fixtures in a release bundle

Fixtures and worst-case data live in `*.testing.ts` modules. Galleries and dev data use them only
in `__DEV__`, so `metro.config.mjs` resolves them to an empty module when Metro bundles for
release. A module that imports one may read it only inside a function or a `__DEV__` branch, never
while it loads: `scripts/testingImports.test.ts` fails on a load-time read, directly or through a
local helper. Build gallery data in a `*.testing.ts` module (as `home/ui/galleryRows.testing.ts`).

## Tokens

Colours and type come from `@polaris/ui/tokens` (Midnight and the mobile type scale), plain
constants with no DOM or Tailwind.
