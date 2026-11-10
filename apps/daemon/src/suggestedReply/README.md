# Suggested Replies: the Polaris fallback

A Suggested Reply (`CONTEXT.md`, ADR 0106) for sessions whose Harness has no suggestions of
its own (`NATIVE_SUGGESTIONS`): today every Harness, Claude Code included, because Claude Code
sends no `prompt_suggestion` through the SDK yet (ENG-891). Its contract is
`packages/protocol/src/suggestedReply.ts`; the native path is the Harness drivers'.

`SuggestedReplies` follows the log for `TurnStarted` and `TurnEnded`. When a Turn ends and
the Host preference (`SuggestedReplyPreference`, via the Engine) is on, it writes one
suggestion with the fallback and offers it with `Engine.offerSuggestedReply(…, "polaris")`,
which commits `SessionReplySuggested` only if that Turn is still the latest and has ended.
The Daemon builds it on top of `Engine.layer` (`transport/serve.ts`); tests use `layerWith`.

- **When** (`suggestionDue`): the user's own session (no `origin`), out of plan mode, not
  Limited, after a completed Turn that isn't the first, an idle compaction or a shell command.
  Not when the fallback's Harness has reached a Plan Limit (`atPlanLimit`: a `reached` window
  in the Usage index). A `warning` doesn't stop it: Claude sends one for a fast pace even at
  low use, and a suggestion is one small request.
- **Which** (`runnableFallback`): the preference's resolution (`resolveFallback`: the Settings
  choice, or when unset the first ready entry of `AUTO_SUGGESTED_REPLY_FALLBACKS`), kept only
  when its Harness is ready and has an inline runner (Claude Code, Codex). Readiness comes from
  `Availability.get("when-stale")`, so a sign-in or install after the Daemon started counts
  within a minute.
- **What**: the last 3 ended Turns' user messages (prompt and steers) and final agent text,
  newest kept within ~6k tokens (`PROMPT_BUDGET_CHARS`). Tools are off and the Harness runs in
  a fresh private directory (`mkdtemp`, removed afterwards), so no project instructions or
  config load, nor anything another user planted in the shared temp directory. The answer is
  `{reply: string | null}`; null or blank commits nothing.
- **Cancellation**: a new Turn, or another ended one, interrupts the request in flight, which
  kills the process. `SUGGEST_TIMEOUT` (15 s) drops a slow one. Every failure is logged only.
- **Traces**: each run's `suggestedReply.suggest` span carries `suggestedReply.outcome`:
  `not-due`, `no-ready-fallback`, `plan-limit-reached`, `no-reply` or `offered`.
- **Usage**: Claude Code runs with `--no-session-persistence` and Codex on an ephemeral thread,
  so nothing is written to the logs the Usage index reads, and no session's Usage counts it.
- **Idle cost**: one log subscription and nothing else. With the preference off, an ended Turn
  reads the setting and stops; the runners load on the first suggestion.

It reuses the inline runners (`../inline/claude.ts`, `../inline/codex.ts`) the way
`../commitMessage/` does. With `POLARIS_BENCH_HARNESS=1`, `benchReply` replaces the vendor
process: it answers `Go ahead.`, or follows a `model` of
`bench:{"answer":{"reply":null},"delayMs":100,"fail":"why"}`.

Focused checks: `bun test apps/daemon/src/suggestedReply`.
