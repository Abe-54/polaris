# Harness availability

Tells Clients, per Host, whether each catalogue Harness is usable (ENG-201, decisions ENG-199 Q9, ADR 0001). Capability `harness.availability`.

| File | Role |
|---|---|
| `probe.ts` | `probeHarness(entry, env)`: one Harness, no side effects. `harnessBinary` finds the binary (`POLARIS_CLAUDE` / `POLARIS_CODEX` / `POLARIS_OPENCODE` / `POLARIS_GEMINI` / `POLARIS_COPILOT`, else PATH), at probe time, so a Harness installed after the Daemon started is found. PATH is the user's: `polaris serve` merges their interactive login shell's PATH (and `~/.local/bin`, `~/.bun/bin`, …) into its own at start (`service/userPath.ts`), since launchd, systemd and `ssh host cmd` all start it bare. |
| `Availability.ts` | The `Availability` service: the cached `HostHarnesses` report and its changes. |
| `AvailabilityRpcs.ts` | `harness.availability` (`refresh` probes again) and `harness.watchAvailability` (the current report, then each new one). |

## Statuses

Checked in this order, stopping at the first that applies:

1. **`not-installed`**: no binary. `signInArgv` is null; Clients show the catalogue's `setup.install` line and link `setup.docsUrl`; Polaris never installs a Harness.
2. **`unknown`**: `<binary> --version` failed. `detail` is its first stderr line.
3. **`outdated`**: the version is below the catalogue entry's `minVersion` (`Bun.semver.order`). Sign-in isn't checked: an old binary may not have the status command.
4. **`needs-sign-in`** / **`ready`** / **`unknown`**, from the Harness's own status command (below).

`signInArgv` is the catalogue's `setup.signInCommand` with the binary the Daemon found as `argv[0]`, for `terminal.open` on the Host. That matters under launchd / systemd, whose PATH often lacks nvm or Homebrew. Polaris never signs in for the user; the Harness does, in its own terminal. Once that terminal exits, a Client asks `harness.availability` with `refresh: true`.

## Versions: a tested version and a soft floor

Each catalogue entry has a `testedVersion`, the one its driver was built and tested against, and a `minVersion`, the oldest it works with. A version below `minVersion` is `outdated`. One at or above it but below `testedVersion` gets its status as usual (usually `ready`) with `olderThanTested` set to the tested version, which Clients show as a quiet "older than tested (2.1.283)" caption, never a signal colour or an update action (DESIGN.md, Settings S1). Polaris never updates a Harness.

| Harness | `testedVersion` | `minVersion` | What was checked |
|---|---|---|---|
| Claude Code | `2.1.283`, the `claudeCodeVersion` the pinned Agent SDK (0.3.283) is built for | `2.1.0` | The SDK checks no CLI version. The flags our options make it pass (`--output-format`, `--input-format`, `--verbose`, `--effort`, `--model`, `--permission-prompt-tool`, `--resume`, `--setting-sources`, `--permission-mode`, `--allow-dangerously-skip-permissions`, `--include-partial-messages`, `--add-dir`; for listing Models `--strict-mcp-config`, `--no-session-persistence`, `--settings`) are all in `claude --help` of 2.1.272 (the oldest on a real Host), and so are the control requests (`initialize` with `forwardSubagentText`, `set_model`, `set_permission_mode`, `apply_flag_settings`) and messages (`task_started`, `task_notification`, `user_message_uuids`) we use. Nothing was checked below 2.1.272; 2.1.0 is the same minor. If an older one refuses `set_model` or `apply_flag_settings`, the Turn still runs on what the query had (`ClaudeDriver.ts`, `tryControl`). |
| Codex | `0.158.0`, the codex-cli the app-server bindings in `../codex/generated/` came from | `0.154.0` | The app-server's params (the JSON schemas `codex app-server generate-json-schema` writes) allow unknown fields, so an older one ignores the newer optional ones. An enum value it doesn't know (`approvalsReviewer: "auto_review"`) is refused with "invalid params": then `thread/start`, `thread/resume` and `turn/start` are sent once more without `approvalsReviewer` (approvals go to the user), `effort` and `excludeTurns` (`../codex/compat.ts`). `model/list` failing leaves the Model list unavailable; Subagents need multi-agent items, which an older one simply doesn't send. |
| OpenCode | `1.18.33`, the opencode the server types in `../opencode/generated/` came from | `1.18.33` | Not relaxed: its HTTP API is unstable (ENG-197). |
| Gemini CLI, Copilot CLI | `0.61.0`, `1.0.89` (measured) | see `../acp/README.md` | Their floors are the ACP features they need. |

## Detecting sign-in without credentials

Each Harness reports its own sign-in state. Polaris never opens, reads or parses a credential file, the keychain or a token. It checks whether the Harness's config directory exists (a `stat`), and it keeps only a boolean from the Harness's answer: the account email and the masked API key the commands print are never forwarded or logged.

| Harness | Command | Reading | Chosen over |
|---|---|---|---|
| Claude Code | `claude auth status --json` | `{"loggedIn": bool, …}`, exit 1 when signed out. Only `loggedIn` is decoded. Unparseable output → `unknown`. | The Agent SDK's `accountInfo()`: it needs a live `query()`, which starts a session and imports the SDK (ENG-196). |
| OpenCode | none | Installed is `ready`: OpenCode's free models (OpenCode Zen) work without any provider. `signInArgv` is `opencode auth login`, for connecting a provider. | `opencode providers list`: nothing to decide from it, since zero providers is still usable, and it reads OpenCode's credential store. |
| Codex | `codex login status` | Exit 0 when signed in; exit 1 with `Not logged in` on stderr when not; anything else → `unknown`. | app-server `account/read`: it needs the app-server, which starts a long-lived process and loads the Codex bindings. |
| Gemini CLI, GitHub Copilot CLI (ACP) | none | No status command exists: without its config directory the Harness has never run here (`needs-sign-in`); otherwise `unknown`, and an `open` that isn't signed in fails with the sign-in hint. See `../acp/README.md`. | ACP `session/new`, which answers "auth required": it starts the agent and a session. |

Side effects, measured on macOS with Claude Code 2.1.284 and codex-cli 0.158.0:

- On a Host where each has run before, `--version` and both status commands leave `~/.claude.json` untouched (same mtime) and `~/.codex` unchanged (same number of `tmp/arg0` entries; Codex reuses them).
- **Claude on a Host where it never ran:** `claude auth status` creates `~/.claude.json` and a backup under `~/.claude/backups/`. So when the config file (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`) doesn't exist, the probe skips the command and reports `needs-sign-in` ("Claude Code hasn't been run on this host yet"). A user signed in only through `ANTHROPIC_API_KEY` who has never run `claude` is therefore shown as needing sign-in; running the sign-in argv fixes that.
- **Codex on a Host where it never ran:** any `codex` invocation, `--version` included, creates `~/.codex/tmp/arg0/…` (helper links). With `CODEX_HOME` set explicitly to a directory that doesn't exist, Codex warns and creates nothing. So every probe command gets `CODEX_HOME` explicitly (the user's, else `~/.codex`), and when that directory doesn't exist `codex login status` is skipped and the Harness reports `needs-sign-in`.
- **OpenCode**: any `opencode` invocation, `--version` included, creates its XDG directories (`~/.config/opencode`, `~/.local/share/opencode`, …). So `--version` runs with `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` under `$TMPDIR/polaris-opencode-probe`, and nothing else runs.
- Claude probes also run with `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so a probe never starts an update or phones home.
- **Gemini CLI:** `--version` writes `~/.gemini/projects.json` temp files, so it runs with `GEMINI_CLI_HOME` on an empty scratch directory, removed afterwards. **Copilot CLI:** `--version` unpacks its package cache into `~/Library/Caches/copilot`, as every start does. Measured with Gemini CLI 0.61.0 and Copilot CLI 1.0.89.
- Every command runs in the user's home directory with stdin closed and a 5 s timeout. A timeout is `unknown`.

Tested with fake binaries on PATH (`probe.test.ts`), which assert which commands ran and that a never-run Host's home stays empty.

## Cost

- **No timers, no watchers.** The layer only makes a `SubscriptionRef`; nothing runs until something asks. The first `harness.availability` or `harness.watchAvailability` probes; later ones answer from the cache. Concurrent asks share one probe.
- **Staleness.** A report older than `STALE_AFTER` (1 min) may miss a sign-in or an install made since, in a terminal Polaris didn't open. `get(false)` still answers it at once and starts a probe, whose report reaches `harness.watchAvailability`; `get("when-stale")` waits for that probe (the Suggested Reply fallback, which would otherwise stay off until a restart); `get(true)` always probes. So an idle Daemon probes no more than it did, and a busy one at most once a minute.
- **No driver is loaded.** This module imports neither the Claude Agent SDK, the Codex bindings nor the OpenCode driver, and doesn't go through `HarnessDriver.probe` (which would load them through `lazyDriver`). `probe.test.ts` checks, in a fresh process, that probing leaves them unloaded.
- A full probe of both Harnesses on an M-series Mac takes about 150 ms: four short-lived processes, run in parallel per Harness.
- `POLARIS_BENCH_HARNESS=1` (benchmarks, the dev Desktop App) reports Claude Code and Codex `ready` at version `bench` without probing them: the bench Harness stands in for exactly those (`../bench/kinds.ts`). Every other Harness is probed as usual.

## Gaps

- The Codex driver still resolves `codex` once, when the registry is built, so a Codex installed after the Daemon started shows `ready` here but can't open a session until the Daemon restarts. Claude's path is looked up per session.
- Nothing refreshes the moment a sign-in terminal exits; the Client asks, and otherwise the next ask after `STALE_AFTER` probes. A Daemon-side refresh on that terminal's exit would need the terminal module to know which terminals are sign-ins.
