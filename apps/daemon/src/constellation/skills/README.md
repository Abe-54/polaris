# Constellation skills

`index.ts` is the single versioned instruction source for Lead and worker roles. H's attachment delivers it through Codex's developer instructions and Claude's system-prompt append. It writes no skills into a Workspace. Repository policy stays in that repository's `AGENTS.md`.

`examples.ts` paraphrases the checked-in M2 accept → fix round → gate loop. Its source paths point to briefs and reports in `.dagr`; those reports contain the lead's review and gate decisions. Raw M2 transcripts were not available, so these are report-derived examples. The cleanup omission, follow-up commits, outside-Area calls, failing regression experiment and disclosed gate failures are taken from those reports. Historical check prose remains Reported evidence; live Verified receipts require the store's recorded command output.

Version 2 adds concrete friendly tool inputs, the distinction between graph, Task and Attempt revisions, send-back placement, user-only decisions, complete Claims and Gate acceptance. The eval is `../../mcp/tools/eval.slow.test.ts` and exercises this loop on the scripted bench Harness and real Constellations service/store.

`preamble.ts` is the versioned Polaris context source. It names the exact tools actually attached to the Session, retains Lead/worker skills, and gives read-only Sessions general context without tools. Codex receives developer instructions; Claude receives a system-prompt append. OpenCode uses its prompt `system` field; ACP sends one context block on the first Turn after start/resume, while normalized prompt text remains only the user's message. Their context says Constellations need Codex or Claude Code; new MCP transports remain a follow-up.

Plain Codex/Claude Sessions receive a bootstrap binding. `plan` with `start` makes the authenticated Session the Lead; the same stable tool catalog then works against the committed graph. Other Lead operations return `E-START-FIRST` before creation, and worker tools are never exposed. No repository files, polling, or tool-list-change notifications are used. The deterministic bench Harness probe for `create a test constellation` asserts a real `plan` call without repository reads; it does not evaluate live Model comprehension.

Version 6 explains identical still-open questions on re-claim: keep id, recipient, text and blocking value unchanged; answered or changed questions need a new id.

Version 7 (after the M3.1 retrospective) asks the Lead for a producer/consumer map before dispatch, one integration owner Task with the Gate depending on it, one construction owner per shared seam, Lead Turns kept for review and scheduling rather than construction, `parent` families for related Tasks so blockers read in one place, `status { since }` for deltas, and treats capacity and transport failures as redispatch, not send-back.
