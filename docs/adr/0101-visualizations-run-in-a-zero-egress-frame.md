---
status: accepted
---

# Visualizations run in a zero-egress frame

## Context

Agents use the `visualize` tool on the Polaris MCP to show Visualizations: HTML pages that
render and run inside the conversation (ENG-594). Agents are meant to use them often, as
ChatGPT's Intelligent UI does. But a Visualization is code the agent wrote, and that agent
works inside your Workspace with your files and secrets in reach. A prompt injection in a
file or a web page could have the agent write a page that sends what it has read somewhere.
Other products draw this line in different places:

- **ChatDCA** (ADR-0031 in dcai) allows no network at all. Its only library is a vendored
  Chart.js, and the frame never sends anything except its height.
- **T3 Code** (`pingdotgg/t3code@35c12103`) sets no host allowlist, so CDN scripts and remote
  URLs load. It also has a two-way bridge modelled on MCP Apps.
- **Claude's own visualize** loads from an allowlist of CDNs and can `fetch` anywhere. An
  allowed CDN is also somewhere data can be sent.

## Decision

**A Visualization can't reach the network, and nothing in the frame reaches the agent.**

- **The frame.** It is an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`,
  giving it an opaque origin. On Mobile it is a WebView limited to local HTML. Its document is
  built by one shared builder, and the first thing in it is a CSP meta tag:
  `default-src 'none'`, inline scripts and styles only, `img-src data:`, `form-action 'none'`,
  `base-uri 'none'`.
- **Libraries.** The only libraries are Chart.js, D3 and the Polaris kit (`pv.*`). Each is
  pinned by sha256 and inlined into the document, so a Visualization renders the same way
  forever from the event log, offline and on a phone.
- **Validation when the agent submits.** The Daemon rejects external URLs, navigation APIs, a
  full document (`<!doctype>`/`<html>`), `vh` units and anything over 128 KiB, and returns an
  error the agent can fix.
- **A frame that navigates away is removed.** A second `load` event replaces the frame with a
  notice. CSP can't block self-navigation (`navigate-to` never shipped), so the guarantee is
  *no persistent or two-way channel*, not that zero bytes can ever leave.
- **Frame → app messages.** These are schema-checked and accepted only when the message comes
  from that frame's own window:
  - its height, clamped to a range;
  - an https link, opened only after you confirm;
  - `pv.state`, stored on this device only and keyed by Visualization id.

  Theme tokens flow the other way, from the app into the frame. No message goes to the agent.

## Consequences

- An agent can't load a library we don't ship or fetch live data. It has to inline the data
  it computed. The tool description and the guidance text say so.
- "Send to agent" (ENG-600) and state synced through the Daemon (ENG-601) each need their own
  design before the bridge widens.
- Adding a library means vendoring it, pinning its hash and checking its licence.

## Desktop enforcement after the security review

R1 (ENG-594) demonstrated that Electron's `disable_non_proxied_udp` policy still allows
TURN over TCP. A closed declarative shadow root can contain a child the in-page
MutationObserver cannot see. Validation rejects this markup, but the host must also
contain unvalidated documents. CSP and media permission handlers are insufficient.

The sandboxed, isolated Desktop preload therefore runs in every frame and uses
`contextBridge.executeInMainWorld` to remove the WebRTC constructors before page scripts
execute. `nodeIntegrationInSubFrames` is enabled for that preload; `nodeIntegration`
remains disabled, and only the main frame installs the Polaris API and IPC listeners.
The frame response also enforces `sandbox allow-scripts`, independently of its iframe
attribute. No app script policy is relaxed.

The real-engine regression bundles the production window, response and preload code.
It verifies that a hidden child actually runs, has no Node or Polaris globals, and sends
neither TCP nor UDP. Removing only the lockdown makes the TCP test fail. Electron
upgrades must rerun it because `executeInMainWorld` is experimental. The shared in-page
guard remains best effort; Mobile engine coverage and resource limits remain tracked.
See [the review and its vector matrix](../research/2026-10-30-visualization-security.md).
