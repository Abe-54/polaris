# @polaris/visualization

Visualizations (ENG-594, ADR 0101): the `visualize` tool input, submit-time validation, the zero-egress frame document (CSP, tokens, Chart.js, D3, the Polaris kit) and the frame↔app messages. Shared by the Daemon, the Desktop App and the Mobile App.

## What's here

| Export | Who uses it | What |
|---|---|---|
| `VisualizeInput`, `VisualizeResult` | Daemon, Clients | The tool's input and its result. |
| `validateVisualization(input)` | Daemon | Problems (`rule`, `message`, `fix`) the agent can act on; `[]` when accepted. |
| `VISUALIZE_TOOL_DESCRIPTION`, `visualizeGuidance(level)` | Daemon | The tool description and the system-prompt guidance for `rich` and `simple` (`off` is `""`). |
| `buildFrameDocument(options)` | Desktop, Mobile | The frame's whole document, for an iframe's `srcdoc` or a WebView's `html`. |
| `FRAME_TOKEN_NAMES`, `FRAME_TOKEN_THEMES`, `FRAME_TOKEN_SOURCES` | Desktop, Mobile | The `--pv-*` tokens, their values in Moonlit, Midnight and light, and the `@polaris/ui` property each is read from. |
| `FrameMessage`, `HostMessage` | Desktop, Mobile | The frame→app and app→frame messages. |
| `frameInbox`, `coalesced`, `boundedJson`, `linkConfirms` | Desktop, Mobile | The app's limits on a frame's messages (ENG-634): see "The bridge's limits". |
| `@polaris/visualization/examples` | Desktop, Mobile | Four hand-made Visualizations that pass validation, as fixtures. |

`VisualizeResult.id` is minted by the Daemon (`viz_<uuid>`), not the Tool Call id: Codex's MCP `tools/call` carries no call id. A Client reads it from the Tool Call's output (one text block holding the result's JSON) and matches it against a later call's `replaces`.

## The frame document

In order: the CSP meta (first thing in `<head>`, before any agent byte), the tokens as `:root` custom properties with `color-scheme`, the base stylesheet and kit CSS, Chart.js, D3, the bootstrap (`pv`, one IIFE so an agent's top-level `const` can't collide with it), then the agent's fragment.

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'
```

- **Tokens.** Clients send `--pv-*` names (or `pv-*`); the frame starts from the scheme's defaults (light, or Moonlit for dark) and overlays what passes the filter: a known name, a value of at most 128 characters with none of `<>{};`. Midnight's values are in `FRAME_TOKEN_THEMES.midnight` for a Client to send.
- **Modes.** `inline` hides vertical overflow and posts its height (`pv:height`, from a ResizeObserver through requestAnimationFrame, with a timer fallback for throttled frames); `expanded` fills its container, with more padding and taller charts.
- **Libraries.** With `libraries: "auto"` (the default) a document inlines Chart.js only when the fragment names `Chart` or `pv.chart`, and D3 only for `d3` or `pv.flow`: the same fragment always gets the same document. `"all"` inlines both.
- **Messages.** The frame posts to `window.parent` with target `*` (its origin is opaque), or, in a React Native WebView, `window.ReactNativeWebView.postMessage(JSON)`. It accepts `pv:theme` only from `window.parent` (or, in a WebView, a message with no source), as an object or a JSON string, on `window` or `document`.
- **State.** `pv.state` is posted as an envelope `{ pv: 1, value, tabs }`: the agent's value beside the kit's remembered tabs. Clients store it as an opaque value and pass it back as `options.state`.
- **Nested frames.** A nested frame is a fresh realm where WebRTC, which CSP doesn't cover, works again. The bootstrap removes any `<iframe>`, `<frame>`, `<object>` or `<embed>` as it is added, in the document and in every shadow root (`attachShadow` is wrapped), and refuses `document.write`, `setHTMLUnsafe` and `Document.parseHTMLUnsafe`. A closed declarative shadow root written in the fragment itself is out of the page's reach; only validation (`shadowrootmode`) stops it, so Clients should also turn WebRTC off for the frame.
- **Links.** A click on any `<a href>` other than `#…` never navigates; an https one posts `pv:open-link`.

## The bridge's limits

A hostile frame can post as fast as it likes; both hosts bound what that costs (`src/bridge/`). These are resource limits, not a verified channel to the agent.

- **Size.** Mobile drops a raw message over `FRAME_MESSAGE_MAX_BYTES` (72 KiB) before parsing it. Desktop receives a structured clone the browser has already built, so it can't refuse it unread; `boundedJson` stops serialising `pv.state` once it passes the 16 KiB state cap.
- **Rate.** `frameInbox` handles at most `FRAME_MESSAGE_RATE` (240) messages a second per frame. Over that, the latest height and the latest state wait for the next slot, so a flood can't lose a slider's last value; anything else is dropped. Unmount and sheet close flush what waits.
- **Heights.** `coalesced` delivers the latest height once per animation frame, and only a change.
- **Links.** Without user activation every link still asks. `linkConfirms` allows one confirm at a time, a 1 s pause after each, and none after three declined in a row until the frame remounts.
- **Mobile state on disk.** One writer per mounted Visualization, evicted when its last frame unmounts; all saved state together stays under 1 MiB and 256 files, least recently written deleted first.

## The kit

`src/frame/kit-css.ts` holds the base stylesheet and every `.pv-*` rule, reading only `var(--pv-*)`, from DESIGN.md's Visualizations section and Paper V9 (ENG-595). Restyle it there. The helpers (`pv.chart`, `pv.bind`, `pv.flow`, `pv.state`, `pv.openLink`, `pv.token`, `pv.onTheme`) are in `src/frame/bootstrap/`; `visualizeGuidance` documents them for the agent.

## Vendored libraries

Inlined into frames as the exact upstream files, pinned by sha256 in `src/vendor/pins.ts` and checked by `src/vendor/vendor.test.ts`. Licence texts are in `vendor/`. To upgrade, change the pin and this table, then run `bun run vendor`.

| Package | Version | File | Licence | sha256 | Bytes |
|---|---|---|---|---|---|
| `chart.js` | 4.6.1 | `dist/chart.umd.min.js` | MIT | 87364cc2b2a76a6684929e7d6b80b18a897794db38400caff1fcf1791c6925d2 | 210,082 |
| `d3` | 7.9.0 | `dist/d3.min.js` | ISC | f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539 | 279,703 |

**Size per frame** (UTF-8 bytes of the document, empty fragment): 32.5 KB with no library (tokens, kit CSS and bootstrap), 243 KB with Chart.js, 312 KB with D3, 522 KB with both. Every frame parses its own copy, so `auto` keeps most frames to one library or none.

## Checks

- `bun run test`: validation rules, the document and its runtime (scripts run in one `node:vm` context over happy-dom, so they share a global lexical scope as in a browser), tokens against `@polaris/ui`, the vendored hashes, the guidance.
- `bun run check:browser`: the documents in real Chrome inside `<iframe sandbox="allow-scripts" srcdoc>`: no request reaches a local server (img, CSS, @import, font, fetch, WebSocket, beacon, form, iframe, object), WebRTC sends no STUN packet (also from a nested `srcdoc` frame, which the bootstrap removes), each of two frames' own guard empties its closed shadow roots (happy-dom's shared prototypes can't show that, ENG-774), heights grow and shrink, `pv:theme` applies live, the examples render at 360 and 728 px. `--shots <dir>` saves screenshots. happy-dom enforces no CSP, so the CSP is only checked here.
