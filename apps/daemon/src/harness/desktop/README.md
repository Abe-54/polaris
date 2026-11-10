# polaris_desktop

Computer use for Agent Sessions (ENG-846, ADR 0104): an MCP server the Daemon runs for each session, wrapping the pinned agent-desktop CLI. Each tool call runs one agent-desktop command and answers its JSON envelope.

- **Where agent-desktop runs.** On macOS inside Polaris Computer Use.app (`ComputerUseHelper.spawn`, responsibility disclaimed), so TCC charges the helper; elsewhere the Host's install (`AgentDesktop`). `runner.ts`.
- **How Harnesses reach it.** One service, `DesktopMcp.forSession`, with a thin adapter each: Claude Code gets an in-process SDK server with its tools pre-allowed (`claude/desktop.ts`); Codex gets a loopback Streamable HTTP URL with a per-session token, its tools pre-approved, and `features.computer_use=false` on every thread (`codex/desktop.ts`, `http.ts`).
- **Who gets it.** Never read-only sessions or the Reviewer. A Ready Host gives every tool; an Off or NeedsSetup one gives only `request_computer_use` (`request.ts`), which opens a `computer-use` approval through the Engine's `ComputerUseRequests` (bound with `bindRequests`, since the Engine is built after the Harness registry) and waits until the Host is Ready or the user says Not now; a NoDesktop Host gives none.
- **Tools.** `catalog.ts`. Values go after `--` and flags as `--name=value`, so input that starts with `-` is never read as a flag; refs must look like `@<snapshot>:e<n>`. Headless: snapshot, find, click, type, set_value, scroll, press, screenshot, list_apps, list_windows, launch, focus_window. Headed (real pointer and keyboard, for apps with no accessibility tree): mouse_click, mouse_move, hover, drag, physical_click, physical_type. A snapshot with no refs, or `ACTION_NOT_SUPPORTED`, tells the agent to screenshot the screen and go headed. A screen screenshot is scaled to one pixel per point on macOS and says how its pixels map to screen points.
- **Per session.** An agent-desktop session (its own snapshot namespace) with the cursor overlay labelled with the session title cut to six words; ended, and ended sessions swept, when the session closes. A display-awake hold (`caffeinate -d`) from a Turn's first call to its `TurnEnded`. A locked screen answers `The screen on <Host> is locked.` without running anything.
- **Tool Calls.** Every result carries `computer_use` (`ComputerUseCall`: the app by bundle id, the window, headed); both translators read it back into `ToolCall.computerUse` (`metadata.ts`).

## Which app, and whether it may

Every call is for one app, resolved to its stable id before anything runs (`session.ts`, `metadata.ts`): the bundle id on macOS, never the display name.

- **Resolving.** The call's `app`, its ref's snapshot or its window's app is looked up with `list-apps --app=<name>`: an exact name or id, else the only match; a name that fits several apps is refused. An app that isn't running (a `launch`) is asked of the Host (`DesktopHost.identify`: `osascript`'s `id of application`, the name passed as an argument). Off macOS agent-desktop gives no id, so the id is the name.
- **One app a call.** A call's `app`, its ref and its window must be the same app, and a ref or window id this session's own snapshots and listings never showed is refused, so a call can't name an allowed app and act on another's window.
- **No app named.** `list_apps` and `list_windows` are about the Host and run unasked. A `screenshot` that names no app shows whatever is on screen, so it runs only while the session controls an app. Any other call that names no app is refused.
- **Headed coordinates.** `mouse_click`, `mouse_move`, `hover` and `drag` go to whatever is at the point, so `list-windows` is read first (`offApp` in `metadata.ts`): the app must be in front (`is_focused`) and every point, rounded as it is sent, inside its focused window, or inside another of its visible windows that no other app's window covers there (the list has no stacking order). Else nothing is sent. A window another app floats above the focused one is not seen.
- **The policy.** `Authorize` (`authorize.ts`) is the Host's `AppControl` (`../../computerUse/control.ts`): the always-refused apps, one session per app, the `app` approval on first use and the `headed-input` approval before headed input. It may wait on the user. The session's apps are released at `TurnEnded` and when the session closes.
- **The user taking over** (`takeover.ts`). Before a headed call, pointer or keyboard input on the Host in the last 1.5 s that came after our own last action refuses the call with "The user took over…". The Host's idle clock (`CGEventSourceSecondsSinceLastEventType`) counts agent-desktop's synthetic input too, so input is the user's only when it is later than our last action plus 300 ms. The call the user just approved is exempt. Checked between actions, not inside one; macOS only.

## Seams for the other computer use tasks

| Seam | Here | Replaced by |
|---|---|---|
| `DesktopHost` (`host.ts`): `state`, `untilReady`, `env`, `locked` | `computerUseDesktopHost`, on D1's `ComputerUseHost`: `state` is `ensure`'s, `untilReady` follows `changes`, `env` is `desktopEnv`. `transport/serve.ts` passes it to `DesktopMcp.layerOn`. | |
| `Acted` (`session.ts`) | None. | D4's `PreviewTargets.acted`, the third argument of `DesktopMcp.layerOn`. |
