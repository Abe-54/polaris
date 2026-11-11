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

**Amended 2026-11-10.** In the end-to-end check, Claude Code 2.1.322 sent no `prompt_suggestion`
through the Agent SDK (`promptSuggestions: true`, haiku and sonnet). So Claude Code sessions use
the fallback too, and `NATIVE_SUGGESTIONS` is empty. The native path stays in the driver,
switched off, until Claude Code sends suggestions (ENG-891).

**Amended 2026-11-11.** Suggestions were too rare to be useful: on 0.9.0, 18 of the 28 fallback
calls that reached the model answered null. A replay of 30 real Turns offered a reply on 17 with
the old instructions and on 30 with the new ones, which ask for the likeliest next message
almost always. The first Turn now gets a suggestion too, since it often ends with the agent's
question. The prompt also quotes the user's past typed prompts from their other sessions, so
the reply sounds like them. The fallbacks are tried in order, the Settings choice first and
then each automatic pick: one that is signed out, failing or at a Plan Limit hands over to the
next ready one (ENG-928).
