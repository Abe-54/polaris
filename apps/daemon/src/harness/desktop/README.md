# polaris_desktop

Computer use for Agent Sessions (ENG-846, ADR 0104): an MCP server the Daemon runs for each session, wrapping the pinned agent-desktop CLI. Each tool call runs one agent-desktop command and answers its JSON envelope.

- **Where agent-desktop runs.** On macOS inside Polaris Computer Use.app (`ComputerUseHelper.spawn`, responsibility disclaimed), so TCC charges the helper; elsewhere the Host's install (`AgentDesktop`). `runner.ts`.
- **How Harnesses reach it.** One service, `DesktopMcp.forSession`, with a thin adapter each: Claude Code gets an in-process SDK server with its tools pre-allowed (`claude/desktop.ts`); Codex gets a loopback Streamable HTTP URL with a per-session token, its tools pre-approved, and `features.computer_use=false` on every thread (`codex/desktop.ts`, `http.ts`).
- **Who gets it.** Never read-only sessions or the Reviewer; only when the Host is ready.
- **Tools.** `catalog.ts`. Values go after `--` and flags as `--name=value`, so input that starts with `-` is never read as a flag; refs must look like `@<snapshot>:e<n>`. Headless: snapshot, find, click, type, set_value, scroll, press, screenshot, list_apps, list_windows, launch, focus_window. Headed (real pointer and keyboard, for apps with no accessibility tree): mouse_click, mouse_move, hover, drag, physical_click, physical_type. A snapshot with no refs, or `ACTION_NOT_SUPPORTED`, tells the agent to screenshot the screen and go headed. A screen screenshot is scaled to one pixel per point on macOS and says how its pixels map to screen points.
- **Per session.** An agent-desktop session (its own snapshot namespace) with the cursor overlay labelled with the session title cut to six words; ended, and ended sessions swept, when the session closes. A display-awake hold (`caffeinate -d`) from a Turn's first call to its `TurnEnded`. A locked screen answers `The screen on <Host> is locked.` without running anything.
- **Tool Calls.** Every result carries `computer_use` (`ComputerUseCall`: the app by bundle id, the window, headed); both translators read it back into `ToolCall.computerUse` (`metadata.ts`).

## Seams for the other computer use tasks

| Seam | Default here | Replaced by |
|---|---|---|
| `DesktopHost` (`host.ts`): `ready`, `env`, `locked` | macOS: the helper's permissions are `ready`; elsewhere agent-desktop is installed. No display env. | D1's `ComputerUseHost`: `ready` is `ensure`'s state is `Ready`, `env` is `desktopEnv`. Pass it to `DesktopMcp.layerOn`. |
| `Authorize` (`authorize.ts`) | Headless calls run; headed calls only with `POLARIS_COMPUTER_USE_HEADED=1` (off by default). Terminals, script runners, System Settings, Keychain Access, Passwords and Polaris are always refused: the tools are pre-allowed, so driving a shell would get around the Harness's approvals. | D3's app and headed-input approvals. |
| `Acted` (`session.ts`) | None. | D4's `PreviewTargets.acted`, the second argument of `DesktopMcp.layerOn`. |
