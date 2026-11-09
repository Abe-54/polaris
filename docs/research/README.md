# Research

Source research behind the Polaris planning map ([ENG-167](https://linear.app/luxdev/issue/ENG-167)). Each file answers one research ticket and cites its primary sources. These are snapshots taken when each ticket closed; for what was decided, read the tickets.

| File | Ticket |
|---|---|
| [herdr-remote.md](herdr-remote.md) | [ENG-168](https://linear.app/luxdev/issue/ENG-168): how herdr handles remote Hosts, image paste and file access |
| [herdr-dagr.md](herdr-dagr.md) | [ENG-169](https://linear.app/luxdev/issue/ENG-169): herdr-dagr's DAG model and how it tracks agent state |
| [t3-code.md](t3-code.md) | [ENG-170](https://linear.app/luxdev/issue/ENG-170): T3 Code's server, protocol, Harness drivers and mobile access |
| [harness-surfaces.md](harness-surfaces.md) | [ENG-171](https://linear.app/luxdev/issue/ENG-171): what Claude Code, Codex and ACP let a UI control |
| [zed-gpui-reuse.md](zed-gpui-reuse.md) | [ENG-172](https://linear.app/luxdev/issue/ENG-172): reusing Zed and GPUI |
| [completion-providers.md](completion-providers.md) | [ENG-173](https://linear.app/luxdev/issue/ENG-173): tab completion and inline chat through ChatGPT sign-in vs local models |
| [gpui-ecosystem.md](gpui-ecosystem.md) | [ENG-182](https://linear.app/luxdev/issue/ENG-182): existing GPUI agent orchestrators and gpui-kit |
| [bun-web-stack.md](bun-web-stack.md) | [ENG-183](https://linear.app/luxdev/issue/ENG-183): whether a Bun and web-tech stack is viable |
| [risk-summary.md](risk-summary.md) | [ENG-186](https://linear.app/luxdev/issue/ENG-186): building blocks for Risk Summaries |
| [weakness-razor.md](weakness-razor.md) | [ENG-187](https://linear.app/luxdev/issue/ENG-187): Bennett's Razor applied to the reviewer's learning loop |
| [multi-model-harnesses.md](multi-model-harnesses.md) | [ENG-197](https://linear.app/luxdev/issue/ENG-197): OpenCode, ACP and other multi-model Harnesses |
| [rules-layer.md](rules-layer.md) | [ENG-220](https://linear.app/luxdev/issue/ENG-220): Betterleaks and ast-grep as the Rules layer on every Host |
| [usage-sources.md](usage-sources.md) | [ENG-198](https://linear.app/luxdev/issue/ENG-198): where Usage and Plan Limits come from without touching credentials |
| [github-review-apis.md](github-review-apis.md) | [ENG-219](https://linear.app/luxdev/issue/ENG-219): GitHub's OAuth device flow and the pull request APIs M2 needs |
| [review-checkout.md](review-checkout.md) | [ENG-221](https://linear.app/luxdev/issue/ENG-221): how the Daemon fetches, checks out, updates and removes a Review Checkout |
| [pierre-diffs.md](pierre-diffs.md) | [ENG-218](https://linear.app/luxdev/issue/ENG-218): whether Pierre Diffs can carry M2's Review view |

Additional planning research: [Editor language tooling](editor-language-tooling.md)
records the 2026-10-02 interview's checkout facts, upstream catalog, and
implementation constraints for [M3.1](../specs/editor-language-tooling-m3.1.md).

The prototype and spike code is throwaway and stays on its own branches, not on `main`:
- `prototype/orchestrator-layout` ([ENG-177](https://linear.app/luxdev/issue/ENG-177))
- `prototype/spike-electron` and `prototype/spike-gpui` ([ENG-184](https://linear.app/luxdev/issue/ENG-184))
- `prototype/pierre-diffs-spike` ([ENG-218](https://linear.app/luxdev/issue/ENG-218))

The original `research/*` branches remain.
- [tab-completion.md](tab-completion.md): tab completion spike; models, latency, context and CodeMirror integration (2026-10-13).
- [decision-models.md](decision-models.md): System One decision models (Jev, Clef, Kev, Laya, llama.cpp) as the Risk Summary classifier backends (2026-10-13).
- [bun-child-process-lost-exit.md](bun-child-process-lost-exit.md): draft upstream report for `node:child_process` losing a child's exit under load, with rates on Bun 1.3.13 and 1.4.3 (ENG-357, 2026-10-17).
- [bun-fs-watch-linux.md](bun-fs-watch-linux.md): draft upstream reports for the two Linux `fs.watch` bugs behind ADR 0046 and ADR 0047 (2026-10-14).
- [computer-use-spike.md](computer-use-spike.md): agent-desktop under the macOS Daemon: TCC identity, prompts, overlay, headless actions, ScreenCaptureKit cost, Linux status ([ENG-846](https://linear.app/luxdev/issue/ENG-846), 2026-11-09).
