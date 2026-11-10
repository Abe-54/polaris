# ENG-630: a closed Codex thread's agent-browser MCP process

Measured 2026-11-09 on the Mac Studio with codex-cli 0.164.0 and agent-browser 0.41.0. A throwaway `codex app-server --stdio` with a temporary `CODEX_HOME` started an ephemeral thread whose `config` held the Browser's `mcp_servers.polaris_browser` entry (`agent-browser mcp --tools core`, as `apps/daemon/src/harness/codex/browser.ts` sets it), sent `thread/unsubscribe` with no Turn, then polled `thread/loaded/list` and the `agent-browser` child's RSS every 5 s.

| `thread_unload_delay_secs` | Unloaded after unsubscribe | MCP child while it waits |
|---|---|---|
| default | 1800 s (`thread/closed` at 1804.4 s; unsubscribe at ~4.4 s) | 10.7 MiB RSS at start, 5.3 MiB after ~35 s, 3.9 MiB from ~6 min on |
| 10 | ~10 s (`thread/closed` at 14.4 s) | exited with the thread |

`unload-default.log` is the default run's output.

- **No unload request.** The generated protocol (`codex app-server generate-json-schema --experimental`, 82 `thread/*` methods) has no unload or close request: `thread/closed` is a notification, and `thread/archive` / `thread/delete` change the user's Codex history.
- **Cost:** one idle process per closed Codex session with the Browser, ~4–6 MiB for 30 minutes, no CPU (it blocks on stdin). A Host that closes ten such sessions in half an hour carries ~50 MiB of them.
- **Fix found:** `thread_unload_delay_secs` (a top-level config key, accepted per thread in `thread/start`'s `config`) shortens the wait without a new RPC.
