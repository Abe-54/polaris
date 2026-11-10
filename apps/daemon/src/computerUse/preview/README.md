# The computer use preview

What a watching Client sees of the window an Agent Session works in (ENG-846, ADR 0107). The wire contract is `packages/protocol/computer-use.md`, "Preview": `computerUse.preview.watch` (live frames) and `computerUse.preview.latest` (one image). The other computer use RPCs are not here.

| File | What |
|---|---|
| `group.ts` | The two RPCs as a group, the capability, and whether this Host captures live. All the transport loads at startup. |
| `targets.ts` | `PreviewTargets`: the window each session last acted on, and the screenshot its last action took. In memory only. |
| `source.ts` | `PreviewSource`: where images come from on this Host. |
| `capture.ts` | The live source on macOS: `polaris-capture` processes. |
| `records.ts` | The parser for what `polaris-capture` writes. |
| `still.ts` | The source everywhere else: the last screenshot as a JPEG. |
| `rpcs.ts` | The handlers. They load with the first call (`transport/lazyComputerUse.ts`). |

## Who tells the preview what to show

The `polaris_desktop` tools call `PreviewTargets.acted(sessionId, { app, window, screenshot })` after each call that acted on an app (`DesktopMcp.layerOn`'s second argument, wired in `transport/serve.ts`). `forget` is for a session that is archived or removed; nothing calls it yet (ENG-879). A call that names no window leaves the session's last window as its target. A window's id is its CGWindowID as text, `4242` or agent-desktop's `w-4242`. Screenshots are whole PNGs, so only the 8 sessions that acted last keep theirs.

## macOS: live capture

`polaris-capture` (`service/computerUse/capture`, Swift, ScreenCaptureKit) sits in Polaris Computer Use.app and is started through its launcher with responsibility disclaimed, so the helper's Screen Recording grant applies and the Daemon needs none.

- **Only while watched.** One process per watched session, size and link, shared by its watchers. It starts with the first watcher and is killed when the last one's stream ends (a disconnect ends it too). With no watcher there is no process, no timer and no polling.
- **No window, no process.** Until the session has acted on a window the watcher gets `Idle { no-window }` and nothing runs.
- **Rate.** The tool is told `PREVIEW_MAX_FPS[link]`: 10 frames a second locally, 2 over SSH, Remote Access and the Relay. It asks ScreenCaptureKit for no more, since WindowServer's cost climbs with the rate.
- **Unchanged frames.** ScreenCaptureKit delivers frames at the cap even for a window that does not change. The tool compares each frame's pixels with the last one it sent and drops the same picture before encoding it.
- **Slow Clients.** Each process publishes into one slot that slides: a watcher still busy with a frame gets the newest one next and never a backlog. A frame becomes a blob only when the Client is ready for its item.
- **Retargeting.** When the session acts on another window the running tool is told on its stdin. A frame of an older window is dropped.
- **Idle reasons.** `no-window` (none yet, or it closed), `screen-locked` (the tool stops capturing until unlock), `not-ready` (no Screen Recording grant: the tool exits 3 and is tried again every 5 s while watched).
- **`latest`.** A watched session's newest frame when it fits the size asked for. Otherwise one image from a tool started for it alone and then killed. Null when the session has no window.

The tool's protocol: the Daemon writes one JSON line per target, `{"window":<CGWindowID or null>,"edge":<px>,"fps":<n>}`, and closing stdin ends the process. The tool writes records: a JSON line, `{"frame":{"window","width","height","capturedAt","bytes"}}` followed by `bytes` of JPEG, or `{"idle":"<reason>"}`.

## Linux and Windows: the last screenshot

There is no live capture and `computer-use.preview` is not announced, so `preview.watch` answers `Unsupported`. `preview.latest` answers the screenshot the session's last action took, scaled to the size asked for and re-encoded as JPEG with `Bun.Image`. It is null before the first action. **On Wayland outside GNOME agent-desktop cannot take a screenshot, so there is never one and `latest` stays null.** A macOS Daemon without the capture tool beside it (run from source) behaves the same way.

## Checking it

- `bun test src/computerUse` (fast): scripted tools stand in for the helper app.
- `swift test` in `src/service/computerUse/capture`: the tool's frame comparison, JPEG fitting and records.
- `bun run bench computer-use-preview --binary <built polaris>`: the real tool on a TextEdit window. The helper beside that binary needs Screen Recording.

Two things only a granted helper shows, both found that way:

- ScreenCaptureKit asserts (`CGS_REQUIRE_INIT`) in a tool that never connected to the window server, from a shell and under a `gui/<uid>` launchd job alike. The tool makes the connection through AppKit once the grant is known. It was not run in `user/<uid>`, where there is no window server to connect to.
- An ad hoc grant covers the helper's seal: replacing `polaris-capture` inside a granted bundle makes it read `not-ready` again until the helper is granted anew.
