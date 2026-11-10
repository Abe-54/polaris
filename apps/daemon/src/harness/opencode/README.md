# OpenCode Harness driver

Implements `HarnessDriver` (`../HarnessDriver.ts`) for OpenCode by driving the user's own `opencode` through the v1 HTTP + SSE API of `opencode serve`. Linear: ENG-203; decisions in ENG-199 (Q10, Q13–Q15) and ADR 0001; research in `docs/research/multi-model-harnesses.md`.

## Design

| File | Role |
|---|---|
| `OpenCodeDriver.ts` | `makeOpenCodeDriver(options)`: the driver value, `probe` (`opencode --version` with throwaway XDG directories) and `listModels`. `capabilities = { steer: true, steerAttachments: true, liveCoAttach: true, switchModel: true, compact: true }`. `HarnessRegistryLive` (`../registry.ts`) imports it on the first `probe`, `listModels` or `open`, in the registry's scope; an idle Daemon never loads it. |
| `Server.ts` | The one `opencode serve` per Host: started on the first lease, shared, stopped when the last lease is released. |
| `Client.ts` | HTTP (basic auth, `x-opencode-directory`) and the `/event` SSE stream for one directory. |
| `OpenCodeSession.ts` | One Agent Session = one server lease + one `/event` stream + one OpenCode session. Commands: `sendTurn`, `steer`, `interrupt`, `respond`, `setPermissionMode`, `terminalCommand`. |
| `translate.ts` | `/event` payloads → `HarnessEvent`s, and the state that needs: the Turn in flight and the open approvals. |
| `context.ts` | How full the context window is (`ContextUsed`), and compactions (ENG-571). |
| `version.ts` | The versions the driver speaks to: OpenCode 2 is refused with a plain reason. |
| `mapping.ts` | Pure translations: permission rulesets, Model ids, tool parts → `TurnItem`s, approvals, prompts. |
| `protocol.ts` | Effect Schemas for the fields the driver reads, each checked at compile time against the generated type. |
| `generated/` | Types generated from the server's `/doc` OpenAPI by `generate.ts`, trimmed to what the driver uses. Generated from **opencode 1.18.33** (`generated/version.ts`). |
| `testing/` | `FakeServer.ts` (real HTTP and SSE on loopback, scripted) and `events.ts` (event builders, fixture reader). |

### One server per Host

`Server.ts` runs `opencode serve --hostname 127.0.0.1 --port 0` with `OPENCODE_SERVER_PASSWORD` set to 32 random bytes, generated per start. It reads the URL from the server's first stdout line (`opencode server listening on http://127.0.0.1:<port>`; OpenCode tries 4096 first). stderr goes to `~/.polaris/logs/opencode-server.log`.

- **Lifecycle** (ENG-199 Q13): each open session holds a lease, and so does a Model listing while it runs. The first lease starts the server, and the last release stops it (SIGTERM, then SIGKILL after 5 s). So the server runs exactly while some OpenCode session is open, i.e. not Dormant, and an idle Daemon runs no OpenCode at all. Closing the registry's scope stops it too.
- **Unlike Codex's app-server, it is the Daemon's child** and doesn't outlive it: the decision is that the Daemon owns it. A Daemon restart ends a co-attached `opencode attach` TUI (it loses its server), and sessions resume by cursor as after any reconnect.
- **Crash recovery**: each start writes `~/.polaris/opencode-server.json` (`{ pid, url }`). The next start stops a recorded server whose command line still names `opencode` and `serve` (pids get reused), so a Daemon that crashed doesn't leak one.
- **Password**: `~/.polaris/opencode-server.password`, mode 0600, removed on stop. It is Polaris's own loopback secret, not a provider credential, and exists so `opencode attach` can read it without the password ever appearing in an argv (`ps`).
- **Workspaces**: every request carries the directory in `x-opencode-directory` (URL-encoded; the server decodes it), so one server serves every Workspace. OpenCode loads an instance per directory on first use. `listModels` uses an empty directory, `~/.polaris/opencode`, so it never loads an instance in the user's home.
- A server that dies is noticed (`proc.exited`); open sessions get `Exited { error }` when their `/event` stream ends, and the next lease starts a new server.

### Turns

OpenCode has no Turn id: a session runs a loop from a user message until it is idle again. The driver maps one run to one Turn:

- `sendTurn`: `POST /session/:id/prompt_async` (204) with a text part, a `file` part per image attachment (`file://` URL of the staged Host path; other attachments are listed by path in the text), a `file` part per composer mention (`@path` or `@"path"` naming a file or folder inside the session's directory, with a `source` pointing at its span in the text, as OpenCode's TUI attaches `@` files), and, per Turn, `model: { providerID, modelID }` and `variant` (the effort). Fails while a Turn is in flight.
- The Turn has begun once OpenCode records its user message (or reports `busy`); it ends at the next `session.idle`. An idle that arrives before the Turn has begun belongs to the previous run and is ignored (OpenCode repeats `session.idle` after an abort).
- `steer`: another `prompt_async` while a Turn is in flight, with that Turn's Model and variant. OpenCode takes a message sent while busy into the running loop, so it joins the Turn and there is still one `session.idle` at the end (verified on 1.18.33). Once OpenCode accepts it, the driver records it in the Turn as a `UserMessage` item. Fails when no Turn is in flight.
- `interrupt`: `POST /session/:id/abort`, or nothing when idle. OpenCode sends `session.error` `MessageAbortedError`, rejects pending permissions (`permission.replied`, so they come back as `ApprovalWithdrawn`), then goes idle: the Turn ends `interrupted`.
- Any other `session.error` completes an `Error` item and the Turn ends `failed` with that message (e.g. Zen's "OpenCode 1.18.0 or newer is required to use the free tier").
- Turns typed in an attached TUI arrive as a user message while no Turn is in flight. The driver mints a `TurnId` and emits `TurnStarted` with the message's text as the `prompt`; if anything else of that Turn comes first, `TurnStarted` goes out then, without a prompt.

### Event mapping

Only events whose `sessionID` is this session's are used; the stream is per directory, so other sessions' events are ignored.

| `/event` | HarnessEvent |
|---|---|
| (session created or resumed) | `CursorAssigned { cursor: sessionID }` |
| `message.updated` (user) + its `text` part | `TurnStarted { prompt }` for a Turn Polaris didn't send |
| `message.part.delta` (`field: "text"`) | `ItemDelta { field: "text" }` (text and reasoning) |
| `message.part.updated` text / reasoning, once `time.end` is set | `ItemCompleted` AssistantMessage / Reasoning (synthetic and ignored text skipped; reasoning timed by the part's `time`) |
| `message.part.updated` tool, `running` | `ItemUpdated`: `bash` → CommandExecution (output from `metadata.output`), `edit`/`write`/`multiedit`/`patch`/`apply_patch` → FileChange (paths from `filePath` or the patch's `*** Add/Update/Delete File:` headers), anything else → ToolCall |
| `message.part.updated` tool, `completed` / `error` | `ItemCompleted`, same mapping; a rejected permission is `declined`, other errors `failed` |
| `message.part.updated` `todowrite` | `ItemUpdated` with a Plan (id `<turn>:plan`); the latest plan is completed just before `TurnEnded` |
| `session.error` | `ItemCompleted` Error (not for `MessageAbortedError`) |
| `session.idle` / `session.status` idle | `TurnEnded` |
| `message.part.updated` `step-finish` | `ContextUsed { usedTokens, windowTokens }` (see Context usage) |
| `message.part.updated` `compaction` (in a user message) + `session.compacted` | `ContextUsed { compacted }` |
| `session.updated` with a new title | `TitleSuggested`, except OpenCode's placeholders (`New session - <date>`) |
| `permission.asked` / `question.asked` | `ApprovalRequested` |
| `permission.replied` / `question.replied` / `question.rejected` for a request Polaris didn't answer | `ApprovalWithdrawn` |
| `/event` stream ends | `Exited { error }`; closing the session gives `Exited { error: null }` |

Step-start, snapshot, patch, agent, subtask and retry parts are not mapped. Cost is left to the Usage index (ENG-205).

### Context usage and compaction (ENG-571)

- **Used**: each `step-finish` part's `input + output + reasoning + cache.read + cache.write`, the tokens that model call carried (OpenCode's own `total`, as its TUI counts context; checked against the recorded 1.18.33 Turn).
- **Window**: the Model's `limit.context` from `GET /config/providers`, read once when the session opens (aside, so a report before it arrives has no window). The Model is the latest assistant message's `providerID`/`modelID`.
- **Compaction**: OpenCode writes a user message with a `compaction` part (`auto: false` for `/compact`, `true` when it compacts a full window itself), then an assistant message marked `summary` holding the summary, then `session.compacted`. The summary's call read the old window, so it isn't usage; on `session.compacted` the driver reports `ContextUsed` with `compacted { trigger, beforeTokens, afterTokens }`, where `after` is the summary's output tokens (the new window, until the next model call reports it).
- **`/compact`**: a Turn whose prompt is `/compact` goes to `POST /session/{id}/summarize { providerID, modelID, auto: false }`, with the Turn's Model, else the session's latest, else OpenCode's configured `model` or first provider's default. It answers once the summary is written, so it runs aside like `/command`; a refusal fails the Turn. `/compact` is listed first in `listCommands` (`run: "harness"`), so idle compaction (ENG-562) covers OpenCode.
- The summarize body, `session.compacted` and the `summary` flag are written from the `@opencode-ai/sdk` 1.18.33 types; `step-finish` and `compaction` parts are in `generated/`.

### Approvals

| OpenCode | ApprovalKind | `respond` sends |
|---|---|---|
| `permission.asked`, `bash` | `command` (title: the command) | Allow → `once` (`always` if `remember`); Deny → `reject` (with the reason as `message`); Answer → `reject` with the text as `message`, which OpenCode hands the model as guidance |
| `permission.asked`, `edit` | `file-change` (detail: the diff) | same |
| `permission.asked`, anything else (`external_directory`, `webfetch`, `task`, …) | `tool` | same |
| `question.asked` | `question` (every question in `questions`; options: the first question's labels; later questions in the detail) | Answer → each question's own answer, else the text; Allow → each question's first option; Deny → `POST /question/:id/reject` |

Replies go to `POST /permission/:id/reply` and `POST /question/:id/reply`.

### Permission modes

A session carries a permission ruleset (`POST /session { permission }`, then `PATCH /session/:id` for `setPermissionMode` and on resume). OpenCode applies the **last** matching rule, and `PATCH` appends, so each ruleset starts with a `*` rule that overrides everything before it.

| Polaris | Ruleset |
|---|---|
| supervised | `*` ask; `read`, `glob`, `grep`, `list`, `lsp`, `todowrite`, `todoread`, `question` allow |
| auto-edits | supervised, plus `edit` allow |
| auto | `*` allow; `external_directory` and `doom_loop` ask. OpenCode has no approval reviewer, so `auto` works freely inside the Workspace and asks to leave it. |
| full-access | `*` allow |

Plan (ENG-466) uses supervised's ruleset and sends each prompt, steer and command to OpenCode's built-in `plan` agent (`agent: "plan"`); leaving plan sends them to the user's default agent again. The plan agent plans instead of building; the session ruleset still asks before any edit or command. Not yet run against a real opencode.

### Models

`listModels` reads `GET /config/providers` (the providers OpenCode can use on this Host, as it resolved them) and `GET /config` (the user's configured `model`). Each Model's id is `provider/model` (split at the first `/`, so OpenRouter ids like `openrouter/anthropic/claude-…` work). Its efforts are its `variants`' names in OpenCode's order, `defaultEffort` is null (no variant), and deprecated Models are left out. The default is the configured `model`, else the first provider's default. **Provider `key` and `options` (which can hold API keys) are never decoded** (ADR 0001).

A session's Model is set on `POST /session` (`model: { providerID, id, variant }`), so an attached TUI shows it, and every Turn carries its own Model and variant. `switchModel` is true.

### Commands (`commands.ts`)

`listCommands(cwd)` leases the server (starting it if no session holds it, as `listModels` does) and reads `GET /command` with the directory `cwd`: custom commands, MCP prompts and Skills (`source: "skill"` → a Skill). `hints` become the argument hint. Every one runs as `text`: a Turn whose prompt starts with `/<name>` naming a listed command goes to `POST /session/{id}/command` `{ command, arguments, model, variant }`, which expands the template as OpenCode's TUI does (`prompt_async` would send `/name` to the model literally). That request answers only once the Turn is done, so it runs aside; if it fails before OpenCode takes the Turn up, the Turn ends `failed`. Attachments aren't sent with a command. Of the built-in TUI commands only `/compact` is offered (see Context usage and compaction); `/undo`, `/share`… are not. `Command` is written by hand in `protocol.ts` from opencode 1.15.5's `/doc` (the installed one; `generated/` is from 1.18.33 and was not regenerated).

### In Terminal: live co-attach

`terminalCommand` is `/bin/sh -c 'OPENCODE_SERVER_PASSWORD="$(cat "$1")" exec "$2" attach "$3" --session "$4" --dir "$5"' opencode-attach <password file> <opencode> <url> <session> <cwd>`: the TUI attaches to the same server and session while Polaris stays attached, like Codex.

Verified with opencode 1.18.33 (`scripts/e2e-opencode-tui.ts`, gated by `POLARIS_E2E_OPENCODE_TUI=1`, on Zen's free tier with throwaway XDG directories): a supervised session takes a Turn from Polaris; the TUI started with `terminalCommand` in a PTY shows its reply; a Turn typed in the TUI reaches Polaris as `TurnStarted` with its prompt within ~0.1 s; its bash approval shows in both the TUI ("Permission required") and Polaris; answering it from Polaris runs the command, the Turn ends `completed` in Polaris with one `ApprovalRequested` and no withdrawal; closing the session stops the server.

### Resume and fork

- **Resume** (`resumeCursor`): `GET /session/:id` (a missing session fails the open), `PATCH` the ruleset for the current mode, then catch up: if `GET /session/status` says the session is busy (a Turn running in the TUI), the driver adopts it as a foreign Turn, and `GET /permission` / `GET /question` reopen that session's pending requests.
- **Fork** is the engine's (`ForkSession`, ADR 0005): the Fork gets a fresh OpenCode session in its own Worktree, primed with the engine's fork preamble. The driver never calls OpenCode's `fork`.
- **Undo** is Polaris checkpoints only; the driver never calls OpenCode's `revert` (ENG-199 Q14).

## Versions

The catalogue's `minVersion` for OpenCode is **1.18.33**, the version `generated/` came from and the e2e ran on.

**OpenCode 2 is not supported yet.** 2.x replaced the v1 API with a new one under `/api` (`/session`, `/event`, `prompt_async` and `summarize` are gone; the paths fall through to its web app). The availability probe reports a 2.x install as `unknown` with "OpenCode 2.0.28 isn't supported yet: Polaris works with OpenCode 1 (1.18.33 or newer)", and the server refuses to start with the same reason (it asks `GET /api/info`, which only 2.x serves). Porting the driver is its own ticket. OpenCode ships weekly and its v1 API is not declared stable. `protocol.ts` fails `bun run typecheck` when a regenerated type drifts from what the driver reads, and decoding is lenient (unknown fields and events are ignored). The ticket's nightly contract test against the latest release is not set up yet (no CI in this repo).

## Regenerating the types

```sh
bun apps/daemon/src/harness/opencode/generate.ts                      # uses `opencode` on PATH
bun apps/daemon/src/harness/opencode/generate.ts --opencode /path/to/opencode
bun apps/daemon/src/harness/opencode/generate.ts --doc doc.json       # from a saved /doc
bun run typecheck                                                      # fails where protocol.ts drifted
```

It starts `opencode serve` with throwaway XDG directories (no config, no credentials), fetches `/doc`, and converts the closure of `ROOTS`, `BODIES` and `RESPONSES` to TypeScript. To use a new payload, add its schema name to `ROOTS` and a schema plus a `conforms<…>` line in `protocol.ts`.

## Tests

- `mapping.test.ts`: the pure rules, including OpenCode's last-rule-wins evaluation of each mode.
- `OpenCodeDriver.test.ts`: the session against `FakeServer`. A full Turn replayed from `fixtures/approval-turn.jsonl` (recorded from a real opencode 1.18.33 Turn with a command approval, paths scrubbed), a TUI-typed Turn, steer, interrupt with a withdrawn approval and a stale idle, an approval answered in the terminal, questions, resume into a running Turn with a pending approval, a provider error, titles and plans, permission modes and Model ids, a dropped server, a missing session, `listModels` (keys never read) and a side-effect-free `probe`.
- `compaction.test.ts`: `ContextUsed` from `step-finish` with the Model's window, `/compact` through `summarize` (the Turn's, the session's or the configured Model), OpenCode's own compaction reported as `auto`, and a refused summarize.
- `Server.test.ts`: the real lifecycle against a fake `opencode` executable: lazy start, sharing, stop on last release and on scope close, auth, the password file's mode, a stale server stopped after a crash, restart after the server dies, start failures, and an OpenCode 2 server refused with its version.
- `e2e.test.ts`: one real Turn with an approved command on Zen's free tier (`opencode/big-pickle`), with throwaway XDG directories, so it uses no credentials:

  ```sh
  POLARIS_E2E_OPENCODE=1 bun test apps/daemon/src/harness/opencode/e2e.test.ts
  ```

  `POLARIS_OPENCODE` picks the binary, `POLARIS_E2E_OPENCODE_MODEL` the Model. Zen's free tier refuses OpenCode older than 1.18.0.
- Through the whole Daemon: `POLARIS_OPENCODE=… bun --cwd apps/daemon scripts/smoke.ts opencode` runs `polaris serve`, asks `harness.availability` and `harness.models`, and runs one real Turn (free Model, throwaway XDG) with its checkpoints and diff.

## Known gaps / TODO

- **Subagents**: the `task` tool's child sessions (`parentID`) show only as a ToolCall; making them Subagents is its own M1.5 ticket.
- **Usage**: per-message cost and tokens are not reported by this driver; ENG-205's Usage index reads them.
- **Bench**: no `opencode` scenario in `packages/bench` yet.
- **Nightly contract test** against the latest OpenCode release: not set up.
- **Instances**: OpenCode keeps an instance loaded per directory until the server stops; the driver doesn't dispose one when its last session in that directory closes.
- **PATH under launchd**: set `POLARIS_OPENCODE` if the Daemon can't find `opencode`.
