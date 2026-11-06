# Contributing to Polaris

Thanks for helping. This guide covers what you need to make a change that passes review. [`AGENTS.md`](AGENTS.md) holds the same rules in the form coding agents read; when the two disagree, `AGENTS.md` wins and this file needs fixing.

## Before you start

- **Read the vocabulary.** [`CONTEXT.md`](CONTEXT.md) defines host, daemon, workspace, agent session, turn, session state and the rest. Use those words exactly in code, comments, docs and UI copy; UI copy writes them in lowercase.
- **Read the product and design docs** for anything a user sees: [`PRODUCT.md`](PRODUCT.md) (users, voice, principles) and [`DESIGN.md`](DESIGN.md) (tokens, components, motion, brand).
- **Check the decisions.** The reasons behind the architecture are in [`docs/adr`](docs/adr), and research notes in [`docs/research`](docs/research).
- **Open an issue first** for a large change, a new dependency, or anything that changes the protocol, so we can agree on the shape before you build it.

## Setup

You need [Bun](https://bun.sh) 1.4.4 or later (the exact version is pinned in `package.json`'s `packageManager`) and git.

```sh
git clone https://github.com/luxdotdev/polaris.git
cd polaris
bun install                        # also installs the git hooks
bun run --cwd apps/desktop dev     # the desktop app, with its own dev daemon
```

Other entry points:

```sh
bun run --cwd packages/ui gallery  # the design system's gallery
bun run --cwd apps/site dev        # the marketing site at localhost:3000
```

Each app and package has a README with its own commands.

## The stack, briefly

- Bun, Turborepo, TypeScript, oxfmt for formatting and oxlint for linting.
- **Effect 4** (pinned exactly, with every `@effect/*` package matching). Its APIs differ from Effect 3: read `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/` rather than older guides. Services use `Context.Service`, functions `Effect.fn`, errors `Schema.TaggedError`.
- **Lifecycle changes go through the state machines** (XState v6 alpha, pinned exactly): session states in `apps/daemon/src/engine/session.ts`, connection states in `packages/client/src/connection.ts`. Never add ad-hoc `if (state === …)` lifecycle code. The event log stays the source of truth; update the model-based tests and the Mermaid diagrams with the machine.
- Terminals use `Bun.Terminal`, never node-pty.

## Making a change

Tests use `bun test` and live next to the code as `*.test.ts`. Before you commit, run the tests for what you changed:

```sh
bun test <path>                    # one file or folder
bun run --cwd <package> test       # a package, both tiers
```

The git hooks then run what they can locally, and a pull request runs the rest; see [Checks](#checks).

### Git hooks

`bun install` points git at `tooling/hooks`. A checkout without dependencies installed is refused with a message.

- **pre-commit** and **pre-push** are described in [Hooks and budgets](#hooks-and-budgets).
- **commit-msg** strips session trailers and session URLs; this repository doesn't record them.

Run the same checks by hand with `bun run quality <files…>` (fixes), or with `--check`, `--dirty`, or `--range <a>..<b>`.

Never bypass a hook with `--no-verify`. If one is broken, fix it or say so in your pull request.

### Lint and maintainability

`bun run lint` is oxfmt's format check plus the lint ratchet. The shared config and the full rule list are in [`packages/lint-config`](packages/lint-config/README.md).

- **The ratchet.** Existing violations are counted per file and rule in `tooling/lint/baseline.json`. Lint fails when a count goes up, so new files must be clean and old files may not get worse. When you fix baselined violations, run `bun run lint:baseline` and commit the lowered counts with the fix. Never raise a count by hand.
- **Size and complexity.** Files stay under 750 lines and functions under a cognitive complexity of 15. Split along seams: a folder whose `index.ts` is the module's interface, not a `utils.ts`.
- **No disable comments** for `max-lines` or `sonarjs/cognitive-complexity`. Any other `oxlint-disable` needs a reason beside it.
- **Comments** are at most two lines and say what the code does or warn about a trap. Why the code is the way it is belongs in an ADR under `docs/adr/`, with a one-line pointer. JSDoc on an API is exempt.
- **Type assertions** need a `// SAFETY: …` line stating the invariant. Parse `unknown` at the boundary with Effect Schema.
- **Effect rules:** build tagged values with their Schema constructors; branch on `_tag` with `Match` or `Predicate.isTagged`; handle tagged errors with `Effect.catchTag`.

Repository-wide formatting commits are listed in `.git-blame-ignore-revs`. Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once to skip them in `git blame`.

### Performance

The daemon must stay light on a Raspberry Pi 4 and a small Linux VM, and the desktop app has budgets (under 1 GB in a heavy session, display-rate frames, a workspace switch under 100 ms). If your change could move memory, CPU or latency, run the relevant benchmark scenarios before and after against your machine's baseline:

```sh
bun run bench sessions history --runs 3 --compare packages/bench/baselines/<machine>.json
```

Don't regress a baseline silently: fix it, or explain it in the commit and update the baseline in the same change. Anything that wakes an idle daemon (timers, polling, watchers) must justify itself in the `idle` scenario. See [`packages/bench`](packages/bench/README.md).

### The specification

The event store, the Engine's streams, recovery, approvals and the Client's resume are specified in Quint in [`packages/spec`](packages/spec/README.md) and tested against the real code by the model-based tests in `apps/daemon/src/verification/`.

A change to how commands are decided, committed, acknowledged, streamed, resumed or recovered (in the protocol, `apps/daemon/src/engine/`, `apps/daemon/src/store/` or `packages/client/src/resume.ts`) must update the spec and its README in the same change, and keep these green:

```sh
bun run spec                             # Quint typecheck, scenario tests, simulator
bun test apps/daemon/src/verification    # model-based tests
```

### User-facing work

Design work starts from `DESIGN.md` and the accepted mockups. Check both themes (dark and light), all three densities, Reduce Motion and the colourblind diff palette. Copy is terse and peer to peer: no emoji, no exclamation marks, and glossary terms exactly as `CONTEXT.md` defines them.

## Checks

This section describes `.github/workflows/ci.yml` and `nightly.yml`. When it disagrees with them, it needs fixing.

### Required lane

The checks that must pass to merge. The `CI` job sums them up: it passes only if every job in this table passed or was skipped by scope. It doesn't wait for a macOS job.

On a pull request, CI selects by what the change affects (`turbo query affected` over the merge commit, which includes dependents). A change to `bun.lock`, `package.json`, `turbo.json`, `tsconfig.base.json`, `patches/`, `tooling/` or `.github/` runs everything, and so does every push to main.

| Job | Runs on | Runs on a pull request when |
|---|---|---|
| Lint (format, ratchet, quarantine), typecheck, licences, scripts, release signer | Linux, once | always |
| Windows platform checks: the remote-only client's tests (`tooling/ci/windows-client-tests.txt`), scripts typecheck | Windows | always |
| Tests, both tiers | Ubuntu: the affected packages. Windows: the daemon's suite | the daemon or another package is affected |
| Spec replays | Ubuntu | `@polaris/spec` is affected |
| Quint spec and trace validation | Ubuntu | `packages/spec/`, `apps/daemon/src/engine/`, `store/` or `verification/`, or `packages/client/src/resume.ts` changed |
| Bench (memory and start-up modules gate; latency and CPU only report) | Ubuntu | the daemon, client, protocol or SDK is affected |
| Desktop budgets | Ubuntu | the desktop app or the daemon is affected |
| Daemon build (every target but darwin), smokes (Linux x64 and arm64, Windows with its pipe), Windows service end to end | Ubuntu for the build, then each platform | the daemon or client is affected, or `scripts/build-daemon.ts` changed |

**macOS** runs its tests, platform checks and darwin daemon build on a pull request only when the change could behave differently there (`tooling/ci/macosScope.ts`): a non-test source file that mentions `darwin`, `launchd`, `codesign`, `macOS` or `process.platform`, or `ci.yml`, `.github/actions/`, `bun.lock`, `package.json`, `patches/`, `scripts/build-daemon*`, `tooling/test/` or `apps/daemon/scripts/`. There they only report, often after `CI` has. On a push to main they always run and the `CI (macOS)` job counts them; the nightly counts its macOS tests too. `CI` itself never includes them, on main or on a pull request, so read `CI` and `CI (macOS)` together for main's state:

| `CI (macOS)` on a push to main | Means |
|---|---|
| passed | every macOS job passed |
| failed | a macOS job failed, timed out, or was cancelled after a runner took it; it files a `ci-red` issue |
| skipped | no result: no runner acquired a macOS job and none failed. This is not a pass; the `macOS result` job's summary names the jobs |

GitHub itself marks a run with a job no runner acquired as failed, so read these two checks, not the run's own status.

### Report lane

These report and block no merge:

- **Nightly**, once a night on main: every package in both tiers on Ubuntu and macOS, and on Windows what CI runs there. A red job files a `ci-red` issue.
- **Apalache**, the spec's bounded check: a step that continues on error in CI, its own job in the nightly.
- **Quarantined tests**, run by the nightly on each OS. The job stays green whatever they do; their issues track them.
- **Property and model-based tests at 500 runs** (`POLARIS_PBT_RUNS=500`), in the nightly on a random seed it prints with the replay command.

### Test tiers

- **Fast tier**: every test file not named `*.slow.test.ts`. Each file has a budget of 2 s. A run lists the files over it, in the job summary under CI; the list warns and fails nothing. Speed a listed file up or rename it.
- **Slow tier**: files named `*.slow.test.ts` (or `.tsx`). A file belongs here when it runs a real daemon process, real network or SSH, heavy real git, model-based or property runs, or Quint, or when it takes over 2 s.

The watchdog behind each package's `test` script takes `--tier=fast|slow|all` and defaults to `all`, so `bun run --cwd <package> test --tier=slow` runs a package's slow tier by hand. No hook runs it; CI is the first place it runs by itself. [ADR 0096](docs/adr/0096-tests-split-into-a-fast-and-a-slow-tier.md) has the details.

### Quarantine

A test that flakes goes into quarantine the first time, and CI never retries it. `tooling/test/quarantine.json` lists each one by file, test, OS, issue and date; every run prints what it skips, and the nightly still runs them.

`bun run lint` fails on an entry without an `ENG-` issue, on one older than 30 days, and on one whose file is gone. When an entry expires, fix the test or delete it. Remove the entry in the change that fixes the test. [`tooling/test/quarantine.md`](tooling/test/quarantine.md) has the steps and the entry format.

### Hooks and budgets

| Where | What runs | Budget |
|---|---|---|
| pre-commit | Format and lint on staged files: fully staged files are formatted and restaged, partially staged ones only checked | under 10 s |
| pre-push | Format and lint on the pushed commits' files without writing, typecheck of the changed packages and their dependents, the changed packages' fast tier, and when `scripts/` changed, its typecheck and tests | under 90 s |
| Required lane | The table above | under 8 min |

The budgets are targets: nothing fails when one is exceeded. Open an issue when you see a hook or the required lane go over. Dependents' tests and the slow tier are CI's job.

### The pull request flow

Every change reaches main through a pull request, so the required lane runs on it, and merges with a merge commit, whose subject names the issue. [ADR 0097](docs/adr/0097-every-change-reaches-main-through-the-required-lane.md) says why.

```sh
gh pr merge <number> --merge --subject "Merge: <what changed> (ENG-123)"
```

Branch protection and auto-merge are not on yet, so check that `CI` is green before you merge. Once they are on, add `--auto` (`gh pr merge --auto --merge …`) and GitHub merges when the required lane passes.

An admin who must merge past a red required lane uses `--admin` and says why in a `ci-bypass: <reason>` line in the merge message:

```sh
gh pr merge <number> --admin --merge --subject "Merge: <what changed> (ENG-123)" --body "ci-bypass: <reason>"
```

The nightly's bypass job lists each merge to main from the last day with that line.

### A red main or nightly

A job that fails, times out or is cancelled on its own on a push to main or in the nightly files a rolling `ci-red` issue in Linear: one open issue per failing job, titled `CI red: <workflow> / <job>`. Cancelling a whole run files nothing, since `ci-red` is cancelled with it. A repeat failure comments on the open issue, and so does a recovery. Nothing closes the issue for you; close it once the job is fixed. If the job failed on a flake, quarantine the test.

A job no runner acquired has no result, so it is neither of those: GitHub cancelled it before any step ran, and its annotation says `The job was not acquired by Runner`. `ci-rerun.yml` re-runs such jobs once when the run finishes on main, unless something else in the run is red, because GitHub's re-run would retry that too. If they still have no result and no re-run is coming, one rolling issue, `CI red: <workflow> / no runner`, lists them and blames no test, and it says so when a later run gets a runner for every job. A job with no steps cancelled for any other reason, such as a job timeout, stays red.

## Borrowed code

Polaris is Apache-2.0. When you copy or adapt code from another project, rather than depending on it:

1. Copy only from permissively licensed sources: MIT, Apache-2.0, BSD, ISC, 0BSD, Unlicense, or MPL-2.0 (file-level). **Never copy from GPL or AGPL sources**, and don't read them for code.
2. Pin the exact upstream commit.
3. Add a header to every file with borrowed code, for example `// Portions adapted from owner/repo@abc1234 (MIT)`.
4. Add an entry to [`ATTRIBUTION.md`](ATTRIBUTION.md): source repository, pinned commit, licence, the Polaris files it landed in, and what changed.
5. Run `bun run licenses:check`. It fails on dependencies outside the allowlist; `bun run licenses` regenerates [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Pull requests

- Keep each pull request to one coherent change, with tests.
- Say what changed and why, and how you checked it. For UI changes, include screenshots in both themes.
- [Checks](#checks) says what CI runs on your pull request, which results block it, and how it merges.
- By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

## Conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in [`SECURITY.md`](SECURITY.md), never in a public issue.
