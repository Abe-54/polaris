---
status: accepted (owner, 2026-11-10)
---

# Suggested Replies fall back to a model chosen in Settings

A Suggested Reply comes from the Harness when it has its own (Claude Code's
`promptSuggestions`, which reuses the session's prompt cache). For a Harness without
one (Codex, OpenCode, ACP), the Daemon writes it with the Harness and Model picked in
Settings, defaulting to the cheapest fast model on an installed Harness. It reuses the
inline runners that `commitMessage/` uses, with tools off, and the prompt holds only the
last 3 Turns' user messages and final agent text, cut to a fixed budget.

We rejected using the session's own Harness and Model. Only Claude Code and Codex have
inline runners, so OpenCode and ACP sessions would get nothing. The fallback also gets no
prompt cache, and running a full-size model on the whole transcript to write one line costs
too much. As a result, a Codex session's suggestion can come from a different vendor's
model; the Settings row says so and states the cost. Fallback calls are not counted in the
session's Usage.

Both sources follow the same rules. There is no suggestion on the first Turn, after a
failed or interrupted Turn, in plan mode, or near a Plan Limit, and either source may
offer nothing. Both commit the same Suggested Reply event to the Agent Session's log, so
the suggestion survives a restart and reaches every Client. A newer Turn makes it stale.
