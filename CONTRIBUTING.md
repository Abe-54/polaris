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

Before you commit, run:

```sh
bun run typecheck && bun run test && bun run lint
```

Tests use `bun test` and live next to the code as `*.test.ts`.

### Git hooks

`bun install` points git at `tooling/hooks`. A checkout without dependencies installed is refused with a message.

- **pre-commit** formats fully staged files with oxfmt and restages them, only checks partially staged ones, and lints staged files through the ratchet.
- **commit-msg** strips session trailers and session URLs; this repository doesn't record them.
- **pre-push** re-checks format and lint on the pushed commits, then typechecks the changed packages and their dependents and tests the changed packages.

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
- CI runs lint, typecheck, tests and the licence check on Linux, macOS and Windows.
- By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

## Conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in [`SECURITY.md`](SECURITY.md), never in a public issue.
