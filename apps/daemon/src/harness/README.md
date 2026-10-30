# Harnesses

One driver per Harness (`claude/`, `codex/`, `opencode/`, `acp/`, and `bench/` for benchmarks), each implementing `HarnessDriver.ts`; `registry.ts` loads them on first use. Each driver's README has its design and its event mapping.

## `harness.commands`: Skills and Slash Commands

`CommandLists.ts` answers `harness.commands` (`{ harness, cwd, refresh }`) through each driver's `listCommands(cwd)`. Every entry says how it runs (`run`):

- `text`: the Turn carries `/name args` (or `$name` for a Codex Skill, or a Codex prompt's `template`) and the Harness reads it.
- `harness`: the Turn carries it, and the driver turns it into the Harness's own call (Codex `/compact`, `/review`).
- `polaris`: the Client does `action` itself (`new-session`, `model`, `diff`, `usage`) and sends nothing.
- Commands only a Harness's terminal UI can run are not listed.

| Harness | Source | Cost |
|---|---|---|
| Claude Code | SDK `supportedCommands()` from a `claude` started in `cwd` with no prompt, classified against a table checked with 2.1.286 | ~0.75–0.9 s |
| Codex | app-server `skills/list` for `cwd`, `$CODEX_HOME/prompts`, and five built-ins | ~0.7 s |
| OpenCode | its server's `GET /command` for `cwd` | one request (plus the server's start if none runs) |
| ACP (Gemini, Copilot) | the latest `available_commands_update` a session in `cwd` sent | none |

Answers are cached per Harness and directory. **Nothing runs at idle**: no timers or watchers. An answer older than 60 s is served as is and read again in the background, once; `refresh` reads again before answering; concurrent askers share one listing, and a failed listing is never cached.

## The Browser's MCP server

`browser/` gives each Claude Code and Codex session that isn't read-only `agent-browser mcp --tools core` as the stdio MCP server `polaris_browser` (ADR 0092). It uses the session's CDP relay URL from `CdpRelay.issue` and the binary from `install/agentBrowser`. Opening a session never waits more than 10 s for it. If the relay fails or the binary isn't installed yet, the session opens without the Browser and a warning is logged, with the token redacted. A missing binary starts its install in the background, so later sessions get the Browser. ACP and OpenCode don't get it yet (ENG-623).

- **The relay URL is never on argv or in an env var.** It sits in the session's config, `~/.polaris/browser-sessions/<sessionId>.json` (`{"cdp": url}`), named by `AGENT_BROWSER_CONFIG`. The file is user-only: mode 0600, or `writePrivateFile`'s protected DACL on Windows. The last open of the session removes it, under one lock with writes so a Harness replacement can't lose a fresh config. The first write in a Daemon sweeps files a crash left behind. Argv is out because the Claude Agent SDK puts `mcpServers` on `claude`'s command line, where `ps` shows it; `mcp --cdp` is ignored by agent-browser's tool calls anyway. An env var is out because the agent's commands and dev servers would inherit it.
- **Not pre-allowed.** It's absent from Claude's `allowedTools` and has no Codex `approval_mode`, so each call follows the session's permission mode. Codex itself lets tools annotated read-only through (snapshot, get title).
- **`core` profile**, pinned: navigation, snapshots, clicks and typing, waits, reads, screenshots, eval and tabs, 29 tools. `state` and `network` reach cookies, credentials and the auth vault; `debug` can install Chrome.
- Each session's agent-browser daemon is `AGENT_BROWSER_SESSION=polaris-<sessionId>`, with a 10-minute idle timeout (an attached browser otherwise never times out). Since its config is Polaris's, the user's `~/.agent-browser/config.json` can't change the attach.
