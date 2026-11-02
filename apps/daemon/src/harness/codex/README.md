# Codex Harness driver

Implements `HarnessDriver` (`../HarnessDriver.ts`) for Codex by driving the user's own, unmodified `codex` binary through `codex app-server`. Linear: ENG-191; decisions in ENG-171 and ENG-175.

## Design

| File | Role |
|---|---|
| `CodexDriver.ts` | `makeCodexDriver(options)`: the driver value. `probe` runs `codex --version` and nothing else. `capabilities = { steer: true, liveCoAttach: true }`. `HarnessRegistryLive` (`../registry.ts`) imports it, and with it the schemas in `protocol.ts`, on the first `probe` or `open`, in the registry's scope; an idle Daemon never loads it. |
| `AppServer.ts` | The one app-server per Host: `codex app-server --listen unix://<socket>`, started lazily on the first `open`, **detached** so it outlives the Daemon (see "App-server lifecycle" below). |
| `RpcConnection.ts` | JSON-RPC 2.0 over app-server's Unix-socket transport, which is **WebSocket over the socket** (HTTP Upgrade, one message per text frame). Bun's WebSocket client speaks it as `ws+unix://<path>`. |
| `CodexSession.ts` | One Agent Session = one connection + one Codex thread. Translates notifications and server→client requests into `HarnessEvent`s. |
| `confinement.ts`, `executable.ts` | A read-only thread's permission profile (ADR 0055); on Linux it also reads the app-server's own binary (from `/proc`), which Codex's bubblewrap runs first. |
| `mapping.ts` | Pure translations: permission modes, turn input, thread items → `TurnItem`s, approval decisions. |
| `models.ts` | `listModels`: `model/list` (every page, hidden Models left out) on the shared app-server when it's running, else on a private `codex app-server` over stdio that exits right after (`connectStdio` in `RpcConnection.ts`). |
| `protocol.ts` | Effect Schemas that validate the fields the driver reads, each checked at compile time against the generated type. |
| `generated/` | TypeScript bindings from `codex app-server generate-ts`, trimmed to the import closure of what the driver uses. Generated from **codex-cli 0.159.2** (`generated/version.ts`). |
| `planLimits.ts` | With `planLimits` set, each session sends `account/rateLimits/read` once it has connected and reports `account/rateLimits/updated` notifications, merged through one `CodexLimitTracker` per driver. See `../limits/README.md`. |
| `testing/FakeAppServer.ts` | A scriptable fake app-server on a real Unix socket (same WebSocket transport) and a replayer for recorded traffic. |

### Shared server and live co-attach

The Daemon owns one app-server per Host on `~/.polaris/codex.sock` (keep it short: Unix socket paths are capped near 104 bytes; app-server itself symlinks long paths, but other clients may not). Each `open` makes its own connection, sends `initialize`/`initialized`, then `thread/start` (fresh) or `thread/resume` with `excludeTurns: true` (`resumeCursor`). The thread id is the cursor (`CursorAssigned`). Closing the session's scope sends `thread/unsubscribe` and closes the connection; the app-server unloads the thread after its own 30-minute idle grace.

`terminalCommand` is `codex resume <threadId> --remote unix://<socket>`. The TUI attaches to the same server, and `thread/resume` on a loaded thread rejoins it, so Polaris and the TUI see the same live events and either can answer an approval. Polaris then gets `serverRequest/resolved` and emits `ApprovalWithdrawn`. Turns the TUI starts reach Polaris as notifications for an unknown Codex turn id. The driver mints a `TurnId` for them and emits `TurnStarted` when the Turn's `userMessage` item arrives, with its text as the `prompt` (app-server sends `turn/started`, then the user message). If anything else in the Turn comes first (Polaris rejoined a thread mid-Turn), `TurnStarted` goes out then, without a prompt. Turns Polaris starts carry the prompt it sent.

Verified on this Host (codex-cli 0.157.1): `--listen unix://PATH` serves WebSocket-over-Unix (a raw HTTP Upgrade returns `101`), and Bun's `ws+unix://` connects to it. `codex app-server proxy --sock` is a raw byte pipe, not a JSONL bridge, so it isn't used. The TUI's `--remote unix://` flag exists on both `codex` and `codex resume`. Live co-attach was exercised by hand with codex-cli 0.158.0 through the real Daemon (`apps/daemon/scripts/e2e-codex-tui.ts`, gated by `POLARIS_E2E_CODEX_TUI=1`; two tiny real Turns): a supervised session takes a Turn from Polaris, goes In Terminal, and `codex resume <thread> --remote unix://…/codex.sock` in a PTY shows that Turn's reply (same thread). A Turn typed in the TUI reaches Polaris as `TurnStarted` within ~0.1 s; its command approval shows in both the TUI ("Would you like to run the following command?") and Polaris (`ApprovalRequested`, kind `command`, on the minted Turn); answering it from Polaris runs the command, the TUI drops its prompt and shows the command as run, Polaris records exactly one `ApprovalRequested` and one `ApprovalResolved`, and the Turn ends `completed` in Polaris. `ReturnFromTerminal` brings the session back to Idle. At that run the TUI's Turn arrived with an empty prompt; `TurnStarted` now carries the TUI Turn's `userMessage` text (ENG-194).

### App-server lifecycle

The server must outlive the Daemon, or a Daemon restart, crash or upgrade would end the user's co-attached `codex --remote` TUI. So it is never the Daemon's child:

- **Start**: `/bin/sh -c '"$@" </dev/null >>log 2>&1 & echo $!'` spawned with `detached: true` (setsid). The shell prints the server's pid and exits, so the server is reparented to init, in its own session and process group, with stdio on `~/.polaris/logs/codex-app-server.log`. No Daemon pipe, process group or PID (which an execve upgrade keeps) ties it to the Daemon. launchd `bootout` of the Daemon's job leaves it running (verified on macOS). Under systemd (`INVOCATION_ID` set), stopping `polaris.service` kills its whole cgroup, so the server is started through `systemd-run --user --scope --collect` in its own scope.
- **Record**: `~/.polaris/codex-app-server.json` holds `{ pid, version, codexPath, socketPath, startedAt, sanitizedEnv }`. New servers set `sanitizedEnv: true`: the launcher explicitly excludes the Daemon's `POLARIS_HANDOFF`.
- **Adopt**: the next Daemon (after a restart, crash or execve upgrade) finds it answering on the socket and connects; Codex sessions resume by cursor as after any reconnect.
- **Replace**: before this Daemon has a connection of its own, it compares the recorded version with `codex --version`. If codex was upgraded and `thread/loaded/list` is empty (no Polaris session or TUI is live on it), the old server is stopped and a new one started; otherwise it is kept. A recorded server that is alive but not answering is replaced. Before any signal, the pid's command line must still name `app-server` and the socket (pids get reused).
- **Stop**: `polaris uninstall` calls `stopAppServer` (SIGTERM, SIGKILL after 5 s, then removes the state file and socket). Tests that spawn a real server must call it too.

**On Windows** (docs/adr/0061-windows-process-trees.md) Codex refuses a Unix socket in any directory ("socket directory is not private to the current user") and Bun can't reach one by a Windows path, so the server (`windowsServer.ts`) listens on `ws://127.0.0.1:0`, a port codex binds itself, with `--ws-auth capability-token --ws-token-file ~/.polaris/codex-app-server/token`: a fresh token per server, in a directory and a file created with a security descriptor of the user's SID alone (owner and DACL), written under a random name and renamed into place (`windowsToken.ts`); a directory another account owns is replaced when it holds only tokens, else refused. The state file is written the same way and ignored when someone else owns it. The server is started suspended with `CreateProcessW`, put in a Job Object with `KILL_ON_JOB_CLOSE` and no breakaway, then resumed (`platform/windowsNative.ts`), so the shim's cmd.exe, node, codex.exe and codex's own commands all end with the Daemon, killed outright included. The port is the 127.0.0.1 listener (`GetExtendedTcpTable`) whose pid is in that job; it is recorded as `listen`, with that process as `listenerPid` and its creation time as `listenerCreated`, and `connectAppServer` checks the port's only listener is still that pid with that creation time before it connects with `Authorization: Bearer <token>`, so a squatter on the port, or one that also got the pid, is sent nothing. `socketPath` stays the key the files are named by. The Daemon's scope stops the server by terminating its job; a starting Daemon stops one it didn't start only while its root or listener runs `app-server` on this home's token file, and the listener only while it is the recorded process. `terminalCommand` is `powershell -EncodedCommand`, which reads the token into `POLARIS_CODEX_TOKEN` and runs `codex resume <thread> --remote <url> --remote-auth-token-env POLARIS_CODEX_TOKEN`. Verified with codex-cli 0.163.0 (npm, `codex.cmd`) on Windows 11 by `apps/daemon/scripts/windows-codex.ts`: started, a thread started on it, the Daemon listed Models through it, the TUI attached in a Daemon terminal, a squatter given the recorded port (with another pid, or with the recorded pid) was refused and sent 0 bytes, the listener check took 0.3 ms, letting it go left no codex or node process, and a process holding it that was killed outright left none either and freed the port.

Servers recorded before environment filtering have no `sanitizedEnv` marker. They may retain an old hand-off envelope even after the Daemon consumes its own copy. A later `open` replaces an idle legacy server, without requiring a Codex version change. Live or uninspectable servers are kept, with one environment-migration log per Daemon lifetime; the next idle `open` retries. Externally managed servers are never migrated. New Daemons validate inherited hand-off descriptors so a child of a retained legacy server still starts fresh safely.

Tests: `AppServer.slow.test.ts` runs the real lifecycle against a fake `codex` executable (`testing/fakeCodex.ts`, which serves `FakeAppServer`): detached and not our child, adopted by a second "Daemon", replaced after a version change only when no thread is loaded, a dead server replaced, stop, and pid-reuse safety.

### Event mapping

| app-server | HarnessEvent |
|---|---|
| `thread/start`/`thread/resume` result | `CursorAssigned { cursor: thread.id }` |
| `turn/started` + `userMessage` item (or first sight of an unknown turn id) | `TurnStarted { prompt }` |
| `item/started` (commands, file changes, tool calls) | `ItemUpdated` (live progress, `running`) |
| `item/agentMessage/delta`, `item/plan/delta`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta` | `ItemDelta { field: "text" }` |
| `item/commandExecution/outputDelta` | `ItemDelta { field: "output" }` |
| `item/completed` | `ItemCompleted`: agentMessage/plan → AssistantMessage, reasoning → Reasoning (summary, else raw content), commandExecution → CommandExecution, fileChange → FileChange (`update` → `modify`), mcpToolCall → ToolCall `server.tool`, dynamicToolCall/collabAgentToolCall/webSearch → ToolCall, imageView → ToolCall `view_image` `{ path }` (a `file://` path made plain), imageGeneration → ToolCall `image_generation` `{ prompt, path }` (`savedPath`, when Codex saved it). A Turn's first user message (its prompt), compaction and review markers are skipped; later user messages are steers (`UserMessage`). |
| `turn/plan/updated` | `ItemUpdated` with the `Plan` (id `<codexTurn>:plan`, its `explanation` when not blank) each time; the latest plan is completed once, just before `TurnEnded` |
| `error` with `willRetry: false` | `ItemCompleted` with an `Error` item, its message made readable (below) |
| `turn/completed` | `TurnEnded { status, error }`, the error made readable (below) |
| `thread/name/updated` | `TitleSuggested` |
| `item/started` / `item/completed` for reasoning | a live `Reasoning` (`ItemUpdated`, empty text) timed from `startedAtMs`, completed with `endedAt` from `completedAtMs` (`reasoning.ts`; the driver's clock when a stamp is missing) |
| `thread/tokenUsage/updated` | `ContextUsed { usedTokens: last.totalTokens, windowTokens: modelContextWindow }` |
| `serverRequest/resolved` for a request Polaris didn't answer | `ApprovalWithdrawn` |
| connection closed by the server | `Exited { error }`; scope close gives `Exited { error: null }` |

Notifications for other threads on the shared server are ignored, except a Subagent's.

**Code mode** (`exec`, checked with codex-cli 0.164.0, ENG-759): app-server sends no item for the `exec` call or its output. A `tools.view_image` inside it arrives as its own `imageView` item, so the Desktop App shows that image; what the script passes to `image()` reaches only the model. The Polaris preamble (`constellation/skills/preamble.ts`) tells the agent so.

**Readable errors** (`readableError` in `mapping.ts`): Codex forwards the provider's error body as the message (`{"type":"error","error":{"message":…}}`, sometimes after a prefix such as `unexpected status 400:`), so the inner `error.message` is used. A rejected Model (`model '<id>' is not …`) becomes "<id> isn't available on this Codex account or plan. Choose another Model." followed by what Codex said. `model/list` has no per-account flag to filter such Models out beforehand (checked with codex-cli 0.158.0 on a "prolite" account: every listed Model has the same `hidden`, `upgrade`, `availabilityNux` and `availableAccessPrograms`).

### Subagents

A Codex agent spawned from the Polaris thread runs in a thread of its own on the same app-server, and its notifications reach the session's connection (verified with codex-cli 0.158.0). `subagents.ts` tracks them:

| parent-thread item | HarnessEvent |
|---|---|
| `subAgentActivity` `started` (multi-agent v2) | a `ToolCall` `agent.spawn` of the Turn (its id is the spawning call's), and `SubagentStarted { subagentId: agentThreadId, parentItemId: that item, title and agent: the agent's name (the last segment of `agentPath`) }`, so the card sits where it was spawned and the Turn's later messages come after it |
| `subAgentActivity` `completed` / `interrupted` | `SubagentEnded` |
| `collabAgentToolCall` `spawnAgent` (v1) | one `SubagentStarted` per `receiverThreadIds` entry (title: the prompt's first line, `model`) |
| `collabAgentToolCall` `agentsStates` | `SubagentEnded` for each agent `completed` / `errored` (→ failed) / `interrupted` / `shutdown` / `notFound` |

Items, deltas and progress on a Subagent's thread are its own (`subagentId` = its thread), under the Polaris Turn that spawned it. Its own Codex turns map to that Turn too, and its `turn/completed` ends nothing. A server request (approval, question) carries its thread: one from a Subagent's thread goes to the Turn that spawned it, or to the Turn in flight when the parent hasn't reported the spawn yet (codex-cli 0.159 asks before it does). It never starts a Polaris Turn: one did, and left two empty Turns stuck working after a Reviewer's real one (`subagentTurns.test.ts`). The collab call itself stays a `ToolCall` of the Turn. `subagents.test.ts` replays `fixtures/subagent-turn.jsonl`, a real Turn that spawned one agent (scrubbed).

### Approvals

| server request | ApprovalKind | `respond` sends |
|---|---|---|
| `item/commandExecution/requestApproval` | `command` | Allow → `accept` (`acceptForSession` if `remember`), Deny/Answer → `decline` |
| `item/fileChange/requestApproval` | `file-change` | same |
| `item/permissions/requestApproval` | `tool` | Allow → grants exactly the requested profile, scope `session` if `remember` else `turn`; Deny → `{}` |
| `item/tool/requestUserInput` | `question` (every question in `questions`) | Answer → each question's own answer, else the text; Allow → each question's first option; Deny → no answers |
| `mcpServer/elicitation/request` | `tool` | Allow → `accept` `{}`; Answer → `accept` `{answer}`; Deny → `decline` |
| anything else (`item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, legacy v1 approvals) | — | JSON-RPC error `-32601`. Polaris never handles credentials. |

**Async questions** are agent messages with `delivery: "async"` and `questions`. They arrive as `item/completed` notifications, not requests, and can outlive their Turn. Each question becomes an `ApprovalRequested` of kind `question`. `respond` with `Answer` sends the text as a new user message: `turn/steer` if a Turn is in flight, otherwise `turn/start` of a new Turn, which gets a minted `TurnId` and a `TurnStarted`. Allow and Deny just close the question.

### Permission modes

| Polaris | `approvalPolicy` | `approvalsReviewer` | sandbox |
|---|---|---|---|
| plan | `untrusted` | `user` | `read-only` |
| supervised | `untrusted` | `user` | `read-only` |
| auto-edits | `on-request` | `user` | `workspace-write` |
| auto | `on-request` | `auto_review` | `workspace-write` |
| full-access | `never` | `user` | `danger-full-access` |

The table follows T3 Code's runtime modes. These values go on `thread/start`/`thread/resume` and on every `turn/start` (as `sandboxPolicy`); Codex persists turn overrides on the thread. `setPermissionMode` takes effect from the next `turn/start`.

**Plan** (ENG-466) is supervised's policy plus Codex's `plan` collaboration mode: the model plans instead of editing, and anything it runs or writes still asks. The collaboration mode is experimental in app-server (`turn/start.collaborationMode requires experimentalApi capability`, codex-cli 0.164.0), so `collaboration.ts` sets it with `thread/settings/update` over its own short experimental connection before each planning Turn, carrying that Turn's Model and effort (the mode takes precedence over them), and sets `default` once when the session leaves plan. If the update fails, the Turn runs supervised and a warning is logged. `planMode.test.ts` covers the requests; `e2e.test.ts` (`POLARIS_E2E_CODEX=1`) runs a real planning Turn that writes nothing.

### Models, effort and fast mode

- **Listing** (`models.ts`): `model/list`, `includeHidden: false`, following `nextCursor`. `Model.id` is the entry's `model` (what `turn/start` takes), `efforts` its `supportedReasoningEfforts`, `defaultEffort` its `defaultReasoningEffort`, `isDefault` as reported. Asking never starts a thread. When the shared server isn't running it is **not** started for a listing (it is detached and would outlive the Daemon): a private `codex app-server` on stdio answers and is killed with the request's scope. Cost measured with codex-cli 0.158.0: ~0.13 s to `initialize`, ~0.5 s for `model/list` (Codex fetches the catalogue for the signed-in account). The Daemon caches the answer per Host (`../HarnessRpcs.ts`).
- **Switching** (`switchModel: true`): each `turn/start` carries the Turn's `model` and `effort`. Codex applies overrides "for this turn and subsequent turns" of the thread, so a Model changed with `SetModel` takes effect at the next Turn without reopening. A null field is omitted, which keeps whatever the thread last ran with; Codex has no way to clear an effort override back to the Model's default, so a Client should send a concrete effort (the Model's `defaultEffort`) rather than null after choosing one. Answers to async questions reuse the last Turn's Model, effort and service tier.
- **Fast mode**: the Session and each Turn record `serviceTier`. `priority` enables fast routing; `default` explicitly disables it; an absent selection preserves the Harness default. Start and resume requests receive it too. The selector and `/fast` share the capability-gated Client settings path (`session.service-tier`, `SetModel`), without creating a Turn. Same-Harness Forks inherit the selection; another Harness clears it.

`OpenOptions.readOnly` overrides every permission mode: `never` approvals, `user` reviewer, and `read-only` sandbox (network off), on thread start/resume and each Turn. Codex Subagents inherit the thread's policy. Late server requests from any thread on the session connection are declined without emitting `ApprovalRequested`; changing the permission mode cannot widen the sandbox.

### Other commands

- `sendTurn`: `turn/start` with a text input, plus a `localImage` input (staged Host path) per image attachment. Other attachments are listed by path at the end of the prompt. Fails if a Turn is already in flight.
- `steer`: `turn/steer` with `expectedTurnId` set to the in-flight turn. Fails if none is in flight. Codex's answer records it as a `UserMessage` item; a Turn's later `userMessage` items (a steer from a co-attached TUI) do too, and `steers.ts` keeps one item when both report the same steer. The Turn's first user message is its prompt.
- `interrupt`: `turn/interrupt`, or nothing when idle. The Turn then ends `interrupted`, and open approvals come back as `ApprovalWithdrawn`.

### Skills and Slash Commands (`commands.ts`, `slash.ts`)

`listCommands(cwd)` asks `skills/list` with `cwds: [cwd]` over the same connection as `model/list` (the shared server if it runs, else a private stdio one that exits; ~0.7 s with codex-cli 0.159.2), reads custom prompts from `$CODEX_HOME/prompts/*.md`, and adds the built-ins Polaris can run:

| Command | How it runs |
|---|---|
| a Skill (`$name`) | `text`: the Turn's text carries `$name`, which Codex's Skill instructions resolve; disabled Skills are left out. Source from its scope (`user`, `repo` → project, `system`/`admin` → built-in) or `plugin` with a `pluginId` |
| `/prompts:<name>` (custom prompt) | `text`, with `template`: the file's body (after frontmatter), `$ARGUMENTS` standing for what follows. app-server doesn't expand prompts (only the TUI does), so the Client sends the body |
| `/compact` | `harness`: a Turn whose prompt is exactly `/compact` runs `thread/compact/start`; the compaction Turn's `turn/started` takes the pending Polaris Turn. Its only item, `contextCompaction`, isn't shown; the new context size arrives as `ContextUsed` |
| `/review [instructions]` | `harness`: `review/start`, inline, target `uncommittedChanges` or `custom` instructions; its reply's Turn is bound like `turn/start`'s. Codex then sends `turn/started` for a second turn id while items and `turn/completed` carry the first: that second id joins the review's Turn and never becomes the Turn in flight |
| `/fast` | `polaris` → `fast` |
| `/model` | `polaris` → `model` |
| `/new` | `polaris` → `new-session` |
| `/diff` | `polaris` → `diff` |
| every other TUI command (`/init`, `/status`, `/mcp`, `/approvals`, `/logout`, `/quit`…) | not offered |

Verified end to end with codex-cli 0.159.2 through the real Daemon (`POLARIS_E2E_CODEX_SLASH=1 bun --cwd apps/daemon scripts/e2e-codex-slash.ts [trace.jsonl]`, gpt-6-luna at low effort): "reply with ok" (~7 s), `/compact` (~1 s), `/review` of a one-line uncommitted change (~25 s, a command and the review as an `AssistantMessage`), then another Turn; each ends `completed`. `slash.test.ts` replays that traffic (`fixtures/slash-turns.jsonl`).

## Regenerating the bindings

```sh
bun apps/daemon/src/harness/codex/generate.ts            # uses `codex` on PATH
bun apps/daemon/src/harness/codex/generate.ts --codex /path/to/codex
bun run typecheck                                         # fails where protocol.ts drifted
```

It runs `codex app-server generate-ts` (stable surface, no `--experimental`) into a temp directory, copies the import closure of the roots listed in `generate.ts` unformatted (oxfmt ignores `generated/`), and rewrites `generated/version.ts`. To use a new message, add its type to `ROOTS` and a schema plus a `conforms<…>` line in `protocol.ts`.

## Tests

- `mapping.test.ts`: the pure rules.
- `CodexDriver.test.ts`: the driver against `FakeAppServer` on a real Unix socket. It covers a full Turn replayed from `fixtures/full-turn.jsonl` (recorded from a real codex 0.157.1 Turn, with paths and account notifications scrubbed), a command approval round-trip, interrupt with a withdrawn file-change approval, resume that rejoins a TUI-started Turn and steers it, a TUI-typed Turn with its prompt and live command and plan progress, an async question answered by a new Turn, refusal of a credential request, a dropped server, and a side-effect-free `probe`.
- `models.test.ts`: `model/list` paging and mapping against `FakeAppServer`, the stdio fallback against a stand-in `codex` script (and that its process is gone afterwards), and each Turn's `model`/`effort` on `turn/start`.
- `e2e.test.ts`: one real tiny Turn against the installed codex in a temp git repo. It uses your Codex sign-in and quota:

  ```sh
  POLARIS_E2E_CODEX=1 bun test apps/daemon/src/harness/codex/e2e.test.ts
  ```

  Set `POLARIS_CODEX_TRACE=/tmp/trace.jsonl` to record every JSON-RPC frame, for example to refresh the fixture.

## Known gaps / TODO

- **MCP form elicitations** accept with empty content; there's no UI for `requestedSchema` yet. An elicitation with no Turn mints a Turn that never ends.
- Nothing restarts a server that dies between `open`s until the next `open`.
- An outdated server with a thread loaded is kept until a later `open` finds it idle; nothing checks again on a timer.
- The `systemd-run --user --scope` path is covered by an argv unit test only; it has not been run on a systemd Host.
- **PATH under launchd**: `Bun.which("codex")` may miss nvm/Homebrew installs when the Daemon runs as a user service. Pass `codexPath` or resolve it from a login shell.
