# ACP Harness driver

One `HarnessDriver` (`../HarnessDriver.ts`) for every curated Harness that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1, stable methods only), driving the user's own, unmodified binary as an ACP agent on stdio. Linear: ENG-208; decisions in ENG-199; research in `docs/research/multi-model-harnesses.md`.

Catalogue Harnesses on this driver: **Gemini CLI** (`gemini --acp`) and **GitHub Copilot CLI** (`copilot --acp`).

## Files

| File | Role |
|---|---|
| `harnesses.ts` | Host-side data per Harness: binary, `POLARIS_<KIND>` override, ACP argv, config directory, scratch-home variable, TUI resume argv; and the permission mode → session mode ids. Plain data: the availability probe and the registry read it without loading the driver. |
| `AcpDriver.ts` | `makeAcpDriver`: the shared agent process (an `RcRef`), `probe`, `listModels`, `open`. Loaded by `../registry.ts` on first use (ENG-196). |
| `AgentConnection.ts` | Spawns the agent, speaks newline-delimited JSON-RPC 2.0, sends `initialize`, and routes `session/update` and `session/request_permission` to the session they name. |
| `AcpSession.ts` | One Agent Session = one ACP session: start/resume, Turns, approvals, interrupt, settings. |
| `translate.ts` | `session/update` → `HarnessEvent`s. |
| `permissions.ts` | Which requests Polaris answers itself by permission mode, how a request reads as an approval, which option a decision picks. |
| `models.ts` | Models and effort from session config options. |
| `protocol.ts` | Effect Schemas for the fields the driver reads, each checked at compile time against `@agentclientprotocol/sdk`'s types (a type-only dev dependency: nothing from it loads at runtime). |
| `testing/` | `fakeAgent.ts`, a scriptable ACP agent run as a real process, and test helpers. |

## Process model

One agent process per Harness per Host serves all of its Agent Sessions (ACP multiplexes sessions by id). It starts with the first `open` and stops when the last session's scope closes; the binary is looked up at each start, so a Harness installed after the Daemon started is found. If it crashes, every open session gets `Exited { error }` (with the last lines of its stderr) and the next `open` starts a new one.

`initialize` offers the agent no file system and no terminal (`fs` and `terminal` false): the Harness uses its own tools, and Polaris sees them as tool calls. Polaris never calls `authenticate` or `logout` (ADR 0001).

## Sessions

- **Start**: `session/new { cwd, mcpServers: [] }`. An agent that answers `-32000` (auth required) isn't signed in: `open` fails with "\<Harness\> isn't signed in on this host." plus the catalogue's sign-in line. The session id is the cursor (`CursorAssigned`).
- **Resume**: `session/resume` when the agent declares `sessionCapabilities.resume`, else `session/load` (declared by `loadSession`), whose history replay is dropped: the engine already has it. An agent that declares neither starts a new session, with a new cursor.
- **Close**: `session/close` when declared; the process stops with the last session.

## Turns

`sendTurn` sends `session/prompt` (text, then each attachment as a `resource_link` to its staged file) and returns once it is written; the response ends the Turn:

| `stopReason` | `TurnEnded` |
|---|---|
| `end_turn` | `completed` |
| `cancelled` | `interrupted` |
| `max_tokens`, `max_turn_requests`, `refusal` | `failed`, with why |
| JSON-RPC error | `failed`, with its message |

One Turn at a time; `steer` isn't in ACP v1, so it fails and the capability is off. `interrupt` sends `session/cancel` and answers the Turn's open permission requests `cancelled` (ACP requires it), withdrawing them (`ApprovalWithdrawn`).

## Event mapping

| `session/update` | HarnessEvent |
|---|---|
| `agent_message_chunk` | `ItemDelta` on an open `AssistantMessage` |
| `agent_thought_chunk` | `ItemDelta` on an open `Reasoning`; its first chunk makes it live (`ItemUpdated`) and it completes timed from that chunk to its close |
| `usage_update` | `ContextUsed { usedTokens: used, windowTokens: size }` |
| `tool_call`, `tool_call_update` (merged by id) | `ItemUpdated` while pending or in progress, `ItemCompleted` once completed or failed. `execute` → `CommandExecution` (command from `rawInput.command`, output from its text content, exit code from `rawOutput.exit_code`/`exitCode`); `edit`/`delete`/`move` with diffs or locations → `FileChange` (a diff without `oldText` is an add); anything else → `ToolCall` |
| `plan` | `ItemUpdated` with the `Plan` (`<turn>:plan`); completed once when the Turn ends |
| `session_info_update` with a title | `TitleSuggested` |
| `notice` with severity `error` | `ItemCompleted` with an `Error` item |
| `current_mode_update`, `config_option_update` | kept as session state |
| `user_message_chunk`, `available_commands_update`, `usage_update`, compaction | ignored |

ACP text chunks have no end marker, so a text item stays open until something else happens in the Turn (a tool call, the other kind of text, a new `messageId`) or the Turn ends, and is then completed once.

## Approvals

`session/request_permission` becomes Needs You unless the permission mode lets its tool kind through, in which case Polaris answers `allow_once` itself:

| Permission mode | Let through without asking |
|---|---|
| plan | `read`, `search`, `think` |
| supervised | `read`, `search`, `think` |
| auto-edits | those, `edit`, `move` |
| auto | those, `execute`, `fetch` |
| full-access | everything |

The approval's kind is `command` for `execute`, `file-change` for `edit`/`delete`/`move`, else `tool`; its detail is the command, the paths, or the raw input. `respond`: Allow → `allow_once` (`allow_always` when `remember`), Deny → `reject_once`, Answer → the option whose name or id matches, else `cancelled`. A denied tool call is completed as `declined`.

The Harness's own policy still applies on its side: when a session offers modes (or a "mode" config option), the permission mode also selects the first matching id from `MODE_IDS` in `harnesses.ts` (for example `yolo` for full-access, `default` for supervised). Plan selects the agent's `plan` (or `architect`) mode; an agent without one gets its supervised mode, so the user gets supervised behaviour: Polaris asks before every edit and command, and the agent isn't told to plan. The mode ids for Gemini CLI and Copilot weren't checked against those binaries (neither is installed on the Host this was built on).

## Models and effort

Through session config options (ACP's current way; the unstable `session/set_model` is not used): the `select` option in the `model` category is the Model, the one in `thought_level` the effort. Before each Turn (and at open) the driver sends `session/set_config_option` for a Model or effort that differs from the session's and that the Harness offers; anything else is left as it is. `listModels` opens a throwaway session in `~/.polaris/acp/<kind>` (closed at once when the Harness declares `close`) and lists the Model choices. ACP gives effort choices for the current Model only, so every Model lists those.

## Commands

ACP agents announce their commands per session (`available_commands_update`); there is no way to ask without one. The driver keeps the latest report per directory (`commands.ts`) and `listCommands(cwd)` returns it: empty until a session in that directory has reported. Each is a `text` command (sent as `/name args` in the prompt, which ACP agents read), its `input.hint` the argument hint.

## In Terminal

No co-attach (`liveCoAttach: false`): the engine closes the session and hands off. Copilot reopens it with `copilot --resume=<session id>`. Gemini CLI's `--resume` takes only `latest` or a list index, so it has no terminal command.

## Availability

`../availability/probe.ts` probes each Harness with `--version` only; ACP Harnesses have no sign-in status command. A Host without the Harness's config directory (`$GEMINI_CLI_HOME/.gemini` or `~/.gemini`; `$COPILOT_HOME` or `~/.copilot`) has never run it: `needs-sign-in`. Otherwise the status is `unknown` ("reports its sign-in when a session starts"), and an `open` that isn't signed in fails with the sign-in hint.

`minVersion`: Gemini CLI `0.33.0`, the first with `--acp` (earlier releases only have `--experimental-acp`). Copilot CLI `1.0.0`, its first general release (ACP, session load and effort config predate it).

Side effects, measured with Gemini CLI 0.61.0 and Copilot CLI 1.0.89 in an empty home: `gemini --version` writes `~/.gemini/projects.json` temp files, so it runs with `GEMINI_CLI_HOME` on an empty scratch directory that is removed afterwards and the home stays empty. `copilot --version` unpacks its own package cache into `~/Library/Caches/copilot` (the same on every start of that version); nothing else.

## Tests

- `AcpDriver.slow.test.ts`: the driver against `testing/fakeAgent.ts` run as a real process. A full Turn (text, thoughts, a tool call, a plan, a title); approvals (Allow with remember, Deny marks declined, auto-allowed by mode); interrupt; one Turn at a time and no steer; not signed in; resume by `session/load` (replay dropped) and by `session/resume`; Model and effort via config options and `listModels`; permission mode → session mode; one shared process, a crash, and a new process after it; terminal handoff; close.
- `e2e.test.ts`: one real tiny Turn against an installed Harness (its own sign-in and quota):

  ```sh
  POLARIS_E2E_ACP=copilot bun test apps/daemon/src/harness/acp/e2e.test.ts
  POLARIS_E2E_ACP=gemini  bun test apps/daemon/src/harness/acp/e2e.test.ts
  # Another ACP agent under that driver, e.g. an adapter:
  POLARIS_E2E_ACP=copilot POLARIS_E2E_ACP_ARGV='["/path/to/codex-acp"]' bun test apps/daemon/src/harness/acp/e2e.test.ts
  ```

  `POLARIS_ACP_TRACE=<file>` appends every JSON-RPC frame.

## Gaps

- `usage_update` (context used and cost) and `PromptResponse.usage` are ignored: `HarnessEvent` has no Usage event yet.
- Sign-in is only known when a session starts; availability reports `unknown` for an installed Harness that has run before.
- Unstable ACP methods (`session/fork`, `session/set_model`, `providers/*`) aren't used, so Fork and Model choice on Harnesses without config options are unavailable.
- Elicitation (`session/elicitation`) isn't offered, so a Harness can't ask free-form questions; questions arrive only as permission options.
- Gemini CLI has no terminal handoff (see In Terminal).
