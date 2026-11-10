# Product

<!-- impeccable:product-schema 1 -->

## Platform

macos

The Desktop App ships for macOS on Apple silicon; a Windows build is experimental and connects only to remote Hosts. The Mobile App (iPhone, including iPhone Duo, and Android) is designed in DESIGN.md's Mobile App section (ENG-458); the iPhone app is in TestFlight by invitation.

## Stack

Electron (decided in ENG-184): Chromium 152, React with the React Compiler, Pierre Diffs for Review, CodeMirror 6 for the Editor. Budgets: display-rate frames (measured at 180 Hz) and under 1 GB for the whole app.

## Users

An individual developer supervising several Agent Sessions at once, across the local Mac and remote Hosts. They read and review far more than they type: most of their time goes to judging what a Harness did, deciding what it should do next, and answering it when it Needs You. They live in the app for hours, mostly in dark mode, and grow from occasional use into power use.

## Product Purpose

Polaris is a native, GPU-rendered IDE and agent orchestrator. It lets one developer launch, watch, steer, and review the work of third-party Harnesses (Claude Code, Codex) across every connected Host, then read and edit the code themselves. Success is a developer who trusts what they are shipping from several agents without watching any of them constantly.

## Positioning

Polaris drives Harnesses rather than reimplementing one, and it supervises Agent Sessions across local and remote Hosts from one window. Review is guided by a Risk Summary that learns from the user's Verdicts, so attention goes where risk is.

## Operating Context

- Long sessions in a single main window, moving between the Orchestrator, Review, the Editor, Data, Traces and Requests.
- Several Agent Sessions in flight at once, on different Hosts and Workspaces, each in one Session State.
- Pull requests and Agent Session Turns reviewed in Review Checkouts, away from the user's own working tree.
- Users sometimes take a session over in the Harness's own terminal UI (In Terminal) and hand it back.

## Capabilities and Constraints

- Vocabulary is fixed by `CONTEXT.md`; UI copy uses those terms exactly, lowercase unless they are proper nouns (agent session, harness, turn, needs you, risk finding, severity, verdict).
- Session States: Starting, Working, Needs You, Idle, In Terminal, Dormant, Failed, Archived.
- Severities: Critical, High, Medium, Low. No Risk Memory may hide a Critical Finding.
- Mobile App scope: the Desktop App's cockpit without the Editor, for starting and continuing agent sessions away from the desk (ENG-458).

## Brand Commitments

- **Name:** Polaris (codename). The north star is the art direction: a night sky in dark mode, a meadow at dawn in light mode.
- **Personality:** calm, precise, alive.
- **Voice:** terse, peer to peer. No emoji, no exclamation marks, no AI hype words ("magic", "supercharge", "seamless"). Glossary terms used exactly and consistently, lowercase in product copy unless they are proper nouns (Polaris, Claude Code, Codex).
- **Brand colour:** a cool starlight white-blue, used sparingly.
- **Signature material:** pixel art and dither.
- **Anti-references:** the "AI purple gradient" look; dashboards crowded with panels, cards, and charts.

## Evidence on Hand

- Visual inspiration: six X posts (calm SF Pro/Inter product UI, pixel icons on watercolour tiles over pixel landscapes, a dither "mode" activation). Not assets; nothing from them may be shipped as-is.
- Nucleo icon library (UI outline and pixel families) via the Nucleo MCP.
- The shipped UI is the first reference: the Desktop App and the Mobile App, the release notes under `docs/releases/`, the gallery (`bun run --cwd packages/ui gallery`) and the brand assets under `design/assets`. New pixel scenes must still be commissioned or made; do not fabricate them from the references.

## Product Principles

1. **Calm by default, dense on request.** The app starts spacious; power users compact it themselves.
2. **Signals stay rare.** Motion means an agent is Working; colour means state, severity, or identity. Anything else is neutral.
3. **Point attention at risk.** The UI ranks what needs a human (Needs You, Critical and High Findings) above everything else.
4. **Identity at a glance.** A Harness is recognisable by its hue without reading a label.
5. **The code is the content.** Chrome recedes wherever the user is reading code or diffs.

## Accessibility & Inclusion

- Every colour signal also carries a shape, icon, or label; diffs offer a colourblind-safe palette.
- Reduce Motion replaces all dither with still pixel patterns.
- Text size is a separate setting from density.
- Full keyboard operation with a visible focus ring on every interactive element.
