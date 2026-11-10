# M3 · Editor: the build spec

These are the decisions from the planning session of 2026-10-02 (Linear map "M3 · Editor").

- **Glossary:** `CONTEXT.md` (Editor, Workspace, Host, Agent Session).
- **UI:** `DESIGN.md` "Editor" and the **Editor artboards in the Paper file** "Polaris — Orchestrator" (01M3JV1J857QNW61TGHZYR6GMZ). The artboards are the source of truth.
- **Research:** `docs/research/completion-providers.md` (ENG-173). The stack decision is ENG-184: CodeMirror 6 for the Editor.

## 1. Scope

| | |
|---|---|
| **v1 (this build)** | Explorer (Files / Changes, git status, agent slots); tabs; CodeMirror 6 reading and editing on **any Host** through the Daemon; syntax highlighting; find in file and in the Workspace; the git gutter; agent awareness; **vim mode**; "Add to agent session ⌘L"; **inline chat ⌘I** through a Harness. |
| **Later (M3.1)** | Tab completion (a local model, per ENG-173); language servers (go to definition, diagnostics, hover). |

## 2. Files on the Daemon (new capabilities)

The file API today reads, stats, lists, searches, greps and watches. It doesn't write. Add:

- **`files.write`:**
  - **Atomic:** write a temp file, then rename. Preserve the file mode and line endings.
  - **Versioned:** takes an **expected version** (mtime plus size plus a content hash). It's rejected with a typed `ChangedOnDisk { current }` if the file moved on.
- **`files.create`, `files.rename`, `files.delete`:** for the explorer. Delete moves the file to the trash where the OS has one; otherwise it asks first in the UI.
- **Watching open files:** reuse the watcher (fff where available), with no new idle cost. Watches exist only for open files and the existing index.
- **Compatibility:** new capabilities, announced as such. Older Clients keep working, and remote Hosts behave the same as This Mac.

## 3. Buffers, saving and conflicts

- **Buffers live in the Desktop App.**
  - Unsaved edits persist locally per Host and path, and survive an app restart.
  - On quit, it asks to save only for files that changed.
  - No autosave by default; there's an "Autosave after a short pause" setting.
- **Agents see only disk.** ⌘L sends the selection's text, so you can share an unsaved edit on purpose.
- **When an agent changes a file you have open:**
  - **No unsaved edits:** the editor reloads in place, keeping the cursor and scroll, with the change briefly highlighted.
  - **Unsaved edits:** a banner reads "Changed on disk by {agent} · Compare · Keep mine · Take theirs". A save never overwrites a newer disk version silently (versioned `files.write`).
- **Editing a file an agent is working on** is allowed, and the tab shows the agent dither. There are no locks.

## 4. The editor

- **CodeMirror 6.**
  - Lezer grammars for TS/JS/TSX, JSON, CSS, HTML, Markdown, Python, Rust, Go, YAML, TOML, SQL and shell, lazy-loaded per language, with a plain fallback.
  - DESIGN.md's moonlit syntax theme, and ligatures off.
- **Tabs, breadcrumbs, gutter (line numbers and git change bars), and find/replace,** as DESIGN.md.
- **Vim mode:** the setting "Editor → Vim mode", off by default, using **`@replit/codemirror-vim`** (MIT, a dependency).
  - **Mode indicator:** NORMAL, INSERT, VISUAL and the `:` line.
  - **Commands:** `:w` saves, `:q` closes the tab, `:wq` does both, and `:e <path>` opens through the ⌘P finder.
  - **Polaris shortcuts** (⌘I, ⌘L, ⌘P, ⌘S, Ctrl+1…9) keep working in every vim mode. Esc belongs to vim; the inline card closes with ✕, or Esc only while the card has focus.
  - **Persistence:** registers (macros included) are shared across tabs for the app session, as in real vim; marks are per tab. (Decided after the M3 fix round; it was "registers and marks per tab".)
  - Zed's vim mode is a behaviour reference only (don't copy its code).

## 5. Explorer, navigation, agent awareness

- **Explorer** per DESIGN.md: Files / Changes; tree rows with an agent slot and a git slot (letters and colours per DESIGN.md); "Agents in {workspace}" below.
- **Where the Editor lives:** Edit mode in the title bar, per Workspace.
- **Open in editor from everywhere:** every `path:line` in the app becomes one shared action. That covers transcripts, Claims, Overview, findings, Changes, and Review's "Open in editor". Plus ⌘P from anywhere.
- **Agent awareness:** a 12px Harness dither leads the tab and the explorer row while an agent is changing that file; the needs-you hand shows on a folder where an agent is blocked.

## 6. Inline chat (⌘I) and Add to agent session (⌘L)

- **Selection bar:** "Edit or ask ⌘I" and "Add to agent session ⌘L", per DESIGN.md.
- **Inline chat goes through a Harness only.** It's an ephemeral Codex app-server thread, or Claude Code `-p`, returning a **structured patch** for the selection (a JSON schema: replacement ranges plus a short summary).
  - Harness and model come from the card's picker chip.
  - No direct LLM backend, and no provider credentials (ADR 0001).
  - Runs read-only: no tools beyond reading the file.
- **The card:** the proposal renders inline as a diff. The footer reads "1 change +2 −1 · Thought for 4s", with Open as agent session, Reject (esc) and **Accept (⌘↵)**. Accept applies the patch to the buffer (not to disk), so it can be undone and is saved like any edit.
- **⌘L** attaches the selected lines as a source to an Agent Session the user picks (default: the last focused session in this Workspace).

## 7. Budgets (a new `editor` bench scenario)

- Open a 1 MB file: under 150 ms on This Mac, under 400 ms on a remote Host.
- Typing: each keystroke paints on the next frame at the display's real refresh rate (p95 of frames late is 0), with about 1 ms of work per key (p95). The work runs from keydown until the key's last handler ends; a key is late by the frames its paint lands after the first frame following that work. Key-to-paint in milliseconds is reported as a diagnostic, not a pass or fail: a literal "one frame at 180 Hz" (5.56 ms) can't be met on a display that runs at 165 Hz (ENG-248).
- 20 open tabs stay inside the 1 GB whole-app budget.
- No idle cost: no new timers or watchers beyond open files and the existing index.
