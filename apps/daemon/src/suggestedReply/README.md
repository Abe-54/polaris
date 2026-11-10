# Suggested Replies: the Polaris fallback

A Suggested Reply (`CONTEXT.md`, ADR 0106) for sessions whose Harness has no suggestions of
its own: every Harness but Claude Code (`NATIVE_SUGGESTIONS`). Its contract is
`packages/protocol/src/suggestedReply.ts`; the native path is the Harness drivers'.

`SuggestedReplies` follows the log for `TurnStarted` and `TurnEnded`. When a Turn ends and
the Host preference is on, it writes one suggestion with the fallback and commits it as
`SessionReplySuggested` with source `polaris`, through `EventStore.commit`. The commit checks
again, under the commit lock, that the Turn is still the session's latest and still due one.

- **When** (`suggestionDue`): the user's own session (no `origin`), out of plan mode, not
  Limited, after a completed Turn that isn't the first, an idle compaction or a shell command.
  Not when the session's Harness or the fallback's is near a Plan Limit (a window that isn't
  `ok` in the Usage index).
- **Which** (`resolveFallback`): the Settings choice when its Harness is ready; when unset,
  the first ready entry of `AUTO_SUGGESTED_REPLY_FALLBACKS`. Only Claude Code and Codex have
  inline runners; anything else resolves to nothing.
- **What**: the last 3 ended Turns' user messages (prompt and steers) and final agent text,
  newest kept within ~6k tokens (`PROMPT_BUDGET_CHARS`). Tools are off and the Harness runs in
  a fresh private directory (`mkdtemp`, removed afterwards), so no project instructions or
  config load, and nothing another user planted in the shared temp directory does either. The answer is `{reply: string | null}`;
  null or blank commits nothing.
- **Cancellation**: a new Turn, or another ended one, interrupts the request in flight, which
  kills the process. `SUGGEST_TIMEOUT` (15 s) drops a slow one. Every failure is logged only.
- **Usage**: Claude Code runs with `--no-session-persistence` and Codex on an ephemeral thread,
  so nothing is written to the logs the Usage index reads, and no session's Usage counts it.
- **Idle cost**: one log subscription and nothing else. With the preference off, an ended Turn
  reads the setting and stops; the runners load on the first suggestion.

It reuses the inline runners (`../inline/claude.ts`, `../inline/codex.ts`) the way
`../commitMessage/` does. With `POLARIS_BENCH_HARNESS=1`, `benchReply` replaces the vendor
process: it answers `Go ahead.`, or follows a `model` of
`bench:{"answer":{"reply":null},"delayMs":100,"fail":"why"}`.

Focused checks: `bun test apps/daemon/src/suggestedReply`.
