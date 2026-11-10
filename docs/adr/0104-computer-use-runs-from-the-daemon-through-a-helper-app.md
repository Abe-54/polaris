---
status: proposed (ENG-846)
---

# Computer use runs from the Daemon, with macOS permissions in a helper app

## Context

Computer use lets an Agent Session operate its Host's desktop apps, under any Harness. It is built
on vercel-labs/agent-desktop (Apache-2.0). Unlike the Browser (ADR 0092, which runs in the Desktop
App), it has to work with no Desktop App connected and on remote Hosts, since the apps it drives
are the Host's own. So it runs from the Daemon.

On macOS it needs Accessibility and Screen Recording grants. The spike
(`docs/research/computer-use-spike.md`) found that when the Daemon spawns agent-desktop, TCC
charges the Daemon (`PolarisDaemon.app`, see the app-bundle ADR). That has four problems:

- Prompts and System Settings show the bundle's folder name ("PolarisDaemon"), not
  `CFBundleDisplayName`.
- A grant to the Daemon covers every child it spawns, every Harness and terminal included, not
  just computer use.
- Dev and release builds share `dev.lux.polaris.daemon`, so they fight over one TCC row, and an ad
  hoc build's grant is keyed to its cdhash and breaks on every build.
- The grant should survive Daemon and agent-desktop upgrades, which needs a stable designated
  requirement owned by computer use alone.

## Decision

- **A Polaris MCP server.** The Daemon serves `polaris_desktop` to each Agent Session that may use
  computer use. It wraps a pinned agent-desktop binary, installed and upgraded on each Host like
  agent-browser. Harnesses see only `polaris_desktop`; Codex's own computer use
  (`features.computer_use`) is turned off.
- **A helper app on macOS.** The permissions belong to **Polaris Computer Use.app**
  (`dev.lux.polaris.computer-use`, Developer ID), which holds agent-desktop and the ScreenCaptureKit
  capture helper in `Contents/MacOS`. The Daemon spawns it with responsibility disclaimed
  (`responsibility_spawnattrs_setdisclaim`, the private SPI Chromium relies on), so TCC checks the
  helper's own grant; stdio is inherited, so MCP over stdio is unchanged. The folder name reads
  well, the grant covers computer use only, dev builds can ship their own helper id, and the
  designated requirement (id plus team) survives upgrades. Codex ships the same pattern with
  "Codex Computer Use.app".
- **Fallback if the disclaim stops working:** launch the helper through LaunchServices and talk to
  it over a socket. An app launched by LaunchServices is its own responsible process, so the
  helper's grant still applies; the spike did not test this path.
- **Polaris enforces policy, not the Harness.** `polaris_desktop` checks app approvals (per app per
  session, in every permission mode, with "always allow" stored per Host), headed approvals (per
  app per session), the built-in always-refused list, and per-app locks (one session controls an
  app at a time; the app is released when the Turn ends). The Harness's own permission modes don't
  relax any of these.
- **Apps with no accessibility tree** (Chromium and Electron apps such as Dia) fall back to
  screenshots and clicks at coordinates. That is headed input, so it needs the app's headed
  approval. Web tasks prefer the Browser.

## Considered Options

- **Grant the Daemon** (`PolarisDaemon.app`): the name is wrong, the grant covers every Daemon
  child, and dev and release builds share one row.
- **Rename the Daemon's folder to `Polaris.app`**, give dev builds their own bundle id, and put
  agent-desktop under `Contents/MacOS`: fixes the name and the shared row, and is the fallback if
  the helper app is rejected, but the grant still covers every Daemon child.
- **Run computer use in the Desktop App**, like the Browser: fails with no Desktop App connected and
  on remote Hosts.
- **Let each Harness's own computer use run** (Codex's): one policy per Harness, none of them aware
  of Polaris approvals or locks, and none on Claude Code.

## Consequences

- Each macOS Host carries a second signed bundle, versioned and staged with the Daemon; release
  signing and notarisation cover it.
- Onboarding on macOS 27 is one step: open Device Control and Data Access and drag the helper in.
  Status still reads Accessibility and Screen Recording separately.
- The disclaim is private SPI: a macOS release can break it, so the LaunchServices fallback stays
  ready.
- Not yet verified: the Developer ID helper keeping its grant across an upgrade (inferred from its
  requirement), and the helper granted and used end to end, overlay included.
- Linux and Windows have no TCC; there the Daemon detects whether a desktop exists itself, because
  agent-desktop's status can't tell no desktop from missing AT-SPI.
