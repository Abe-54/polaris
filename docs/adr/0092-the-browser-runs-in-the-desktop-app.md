---
status: accepted (owner, 2026-10-30; built in ENG-612)
---

# The Browser runs in the Desktop App, not on the Host

## Context

An Agent Session's Browser must show the Host's dev servers and let the session's agents drive
them. T3 Code runs a headless Chrome on the remote server and streams JPEG frames to the client;
that keeps agents browsing with no client attached, but costs a ~120 MB Chrome download and
hundreds of MB per browser on the Host, has no Linux arm64 Chrome for Testing build, and gives
the user a lossy stream with no DevTools or audio.

## Decision

The Browser is an Electron WebContentsView in the Desktop App, in a persistent partition per
Workspace. Agents drive it with `agent-browser mcp --cdp <url>`, injected as an MCP server per
Agent Session: the Daemon serves each session a token-guarded loopback CDP WebSocket and relays
it to the Desktop App hosting that session's Browser, exposing only that session's targets and
refusing browser-wide methods (other contexts, `Browser.close`, downloads to arbitrary paths).
The hosting Desktop App is the one that last showed the Browser, else the one the user is
present at; it opens the Browser in the background when it is not on screen.

## Considered Options

- Headless Chrome on the Host, streamed (T3 Code): breaks the Raspberry Pi budget.
- Both runtimes: two implementations to keep in step; possible later as an opt-in per Host.
- Polaris-native browser tools on the `polaris` MCP server: no new binary, but a port of
  agent-browser's snapshot and ref logic and image results in the MCP adapter first.

## Consequences

- A browser tool call fails when no Desktop App is connected to the Host; an unattended Turn
  loses its Browser when the laptop closes.
- This is the first Daemon-to-Client request: the Daemon must know which connection hosts a
  session's Browser.
- Each Host's Daemon installs and upgrades a pinned agent-browser binary (~16 MB).
- agent-browser's `--allowed-domains` does not work when attached, so any navigation limit
  belongs in the CDP relay.
