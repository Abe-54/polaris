# Polaris — agent guide

Polaris is an IDE and agent orchestrator: a Bun Daemon per Host, an Electron Desktop App, and an Expo React Native Mobile App (in TestFlight). Read these before changing anything:

- `CONTRIBUTING.md`, before changing code: its Checks section defines the required and report lanes, test tiers, quarantine, budgets and the PR flow.
- `CONTEXT.md`: the glossary. Use its terms exactly (Host, Daemon, Workspace, Agent Session, Turn, Session State…) in code, comments and UI copy.
- `PRODUCT.md` and `DESIGN.md`: product truth, voice and the UI spec.
- Any user-facing work (Paper mockups, the Desktop App, copy, brand): load the `product-design` skill (`.agents/skills/product-design/`) first.
- The decisions behind the architecture are on the Linear map ENG-167 (each closed ticket holds its resolution); research is under `docs/research/`.

## Layout

| Path | What |
|---|---|
| `packages/protocol` | The wire contract: Effect Schema domain, events, commands, the `DaemonRpcs` group, and frame codec. Every Client and the Daemon depend on it. |
| `packages/sdk` | The public SDK for Extensions (`@polaris/sdk`): pairing strings, the socket and gateway transports, Host and session feeds, commands; a Promise API and an Effect API. The protocol is bundled in at build (see its README). |
| `extensions/even-g2` | The Even Realities G2 glasses app (`@polaris/even-g2`): agent sessions, approvals and voice replies on the glasses over `@polaris/sdk`, pairing on the phone; packed for Even Hub (see its README). |
| `packages/client` | Client runtime: connections to many Daemons over SSH, Connection State, resume, install/upgrade. |
| `packages/predict` | The fill-in-the-middle predictor behind tab completion (`@polaris/predict`): runs in the Client main process and the Daemon, on TypeScript, Effect and web APIs only (see its README). |
| `packages/syntax-diff` | The syntax-aware diff: token alignment (Myers over tokens), patches with token emphasis, and tokenizers behind a small interface (the TypeScript parser; the Desktop App adds the highlighter's tokens). |
| `packages/visualization` | Visualizations (`@polaris/visualization`, ADR 0101): the `visualize` tool input, submit-time validation, the zero-egress frame document and the frame↔app messages; shared by the Daemon, the Desktop App and the Mobile App. |
| `packages/bench` | Benchmarks: the real Daemon under scripted load, a process-tree memory/CPU sampler, baselines and comparisons. |
| `packages/spec` | The Quint spec of commits, streams, Client feeds and approvals, and its checks (see Verification). |
| `apps/daemon` | The Daemon (`polaris` binary): event store, Harness drivers, transport, files, git, terminals, user service. |
| `apps/relay` | The Polaris Relay, in Rust: a Cargo workspace (the relay, its load generator) and its TypeScript contract suite (`@polaris/relay`). Its README is the wire contract. Tests that start a relay build it with cargo (ADR 0105). |
| `extensions/raycast` | The Raycast extension on `@polaris/sdk`: search Agent Sessions and Workspaces, Pending Approvals, New Agent Session, Hosts (see its README). A root workspace, like everything under `extensions/`. |
| `apps/site` | The marketing site (Next.js on Vercel, root directory `apps/site`), built from the Paper "Marketing site" page on `@polaris/ui`'s tokens; the download and update-feed routes live under `app/` (see its README). |
| `apps/desktop` | The Electron Desktop App: the Client runtime in the main process, a typed IPC bridge, a React renderer on `@polaris/ui` (see its README). |
| `apps/mobile` | The Mobile App: Expo React Native on Hermes over `@polaris/sdk` and the Client runtime; the Hermes check of the shared runtime (see its README). |
| `packages/ui` | The design system in code (`@polaris/ui`): DESIGN.md's tokens on Tailwind v4, restyled shadcn/ui, the Polaris primitives, and a gallery (`bun run --cwd packages/ui gallery`). |
| `packages/lint-config` | The shared oxlint config every workspace extends, the shared oxfmt style (`oxfmt.json`), and the custom plugins (`polaris/no-long-comment`, vendored anti-slop, the SonarJS cognitive-complexity wrapper). Read its `README.md` before touching lint rules. |
| `tooling` | The lint ratchet and its baseline (`tooling/lint`), the quality runner behind the git hooks (`tooling/quality`), and the hooks (`tooling/hooks`). |

## Stack and conventions

- Bun ≥ 1.4.4 (pinned in `packageManager`), Turborepo, TypeScript 7, oxfmt (formatting), oxlint (linting).
- **Effect 4** (`effect@4.0.0-rc.118`, pinned exactly; the `@effect/*` packages must match). APIs differ from Effect 3: read `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/` rather than relying on memory. RPC is `effect/rpc`, SQL is `effect/sql`, sockets `effect/socket`.
- Services use `Context.Service`; functions use `Effect.fn`; errors are `Schema.TaggedError`.
- Tests use `bun test`, next to the code as `*.test.ts`. Every test must fail if the behaviour it names breaks; before adding one, ask what bug it would catch. Don't write tautological tests:
  - asserting what the test itself just set up, or that a mock returns what it was told to;
  - copying the implementation's constants or logic into the expectation;
  - restating what the types or an Effect Schema already guarantee;
  - checking only that mocks were called, in order, instead of the outcome;
  - `toBeDefined`/`toBeTruthy` on a value that can't be missing, or no assertion at all;
  - repeating a behaviour another test already covers at the same level (parametrize instead).
  Assert observable outcomes through the real code, with fakes only at the boundary (the fake GitHub, fake Harnesses, test Layers). Product copy is a real requirement and may be asserted; incidental output is not. When you fix a bug, add the test that fails without the fix.
- Each package's `test` script runs `bun test` through `tooling/test/watchdog.ts`: a run silent for `POLARIS_TEST_STALL_S` seconds (default 300) is killed and the stuck file named. Local runs are parallel (`--parallel=N`, N half the cores, at least 2); `POLARIS_TEST_PARALLEL=N` overrides it, 1 is serial; CI keeps its own flags. Keep new packages on it.
- Tests come in two tiers (ADR 0096). A file is slow-tier, named `*.slow.test.ts`, when it runs a real Daemon process, real network or SSH, heavy real git, model-based or property runs, or Quint, or takes over 2 s; every other file is fast-tier and keeps under 2 s. The watchdog takes `--tier=fast|slow|all` (default all): pre-push runs the fast tier, CI runs both, and a run lists the fast files over budget.
- Never use node-pty; terminals use `Bun.Terminal`.
- **Lifecycle changes go through the state machines**, never ad-hoc `if (state === …)` code: Session States through the Agent Session machine (`apps/daemon/src/engine/session.ts`, the engine's pure decider; see its README), Connection States through `packages/client/src/connection.ts`. They use XState v6 (`xstate@6.0.0-alpha.61`, an alpha, pinned exactly): read the bundled types in `node_modules/xstate/dist/declarations` rather than v5 docs or memory. The event log stays the source of truth: a machine snapshot is always derived from folded events, never kept only in an actor. Update the model-based tests (`*.testing.ts`, `*.graph.slow.test.ts`) and the Mermaid diagrams with the machine.
- Before committing, run the tests for what you changed (`bun test <path>`, or `bun run --cwd <package> test` for both tiers). The hooks below run format, lint, typecheck and the fast tier; the required lane runs the rest on your PR.

## Lint and maintainability

oxfmt formats (`bun run format`; config in `oxfmt.config.mts`, built on `packages/lint-config/oxfmt.json`); oxlint lints, with the shared config in `packages/lint-config` (its `README.md` has the full rule list and policy). `bun run lint` is oxfmt's format check plus the lint ratchet.

Repo-wide formatting commits are listed in `.git-blame-ignore-revs`, GitHub's blame skips them; locally run `git blame --ignore-revs-file .git-blame-ignore-revs`, or `git config blame.ignoreRevsFile .git-blame-ignore-revs` once (git then fails to blame in checkouts without the file, such as branches older than it). Add any future formatting-only commit there.

- **The ratchet.** Existing violations are counted per file and rule in `tooling/lint/baseline.json`. Lint fails when a count goes up, so new files must be fully clean and old files may not get worse. When you fix baselined violations, run `bun run lint:baseline` and commit the lowered counts with the fix. Never raise a count by hand; `--rebaseline` is only for introducing a new rule, and says so in the commit.
- **Size and complexity.** Files stay under 750 lines (blank lines don't count; comments do) and functions under a cognitive complexity of 15. Split along seams: a folder whose `index.ts` is the module's interface, never a `utils.ts` dumping ground.
- **No disable comments** for `max-lines` or `sonarjs/cognitive-complexity`. Any other `oxlint-disable` needs a reason next to it and will be questioned in review.
- **Comments**: at most two lines of prose (`polaris/no-long-comment`). A comment says what the code does or warns about a trap at this call site; *why* the code is this way goes in an ADR under `docs/adr/`, with a one-line pointer. JSDoc on an API is exempt.
- **Type assertions** need a `// SAFETY: …` line stating the invariant that makes them true. Parse `unknown` at the boundary with Effect Schema rather than passing it around or narrowing with `typeof`.
- **Effect rules** (anti-slop-effect, on everywhere):
  - `no-manual-tagged-construction`: build tagged values with their Schema `.make` / class constructor, so they're checked.
  - `no-manual-tag-comparison`: branch on `_tag` with `Match.tag`/`Match.tags` or `Predicate.isTagged`, so exhaustiveness is checked.
  - `prefer-effect-match`: a chained literal ternary over one value becomes a `Match`.
  - `no-manual-effect-error-tag`: handle tagged errors with `Effect.catchTag`/`catchTags`, not by inspecting `_tag` in a broad catch.
  - `no-service-constructor-imports`: runtime code yields a service from its Layer instead of importing its `make…` constructor.

## Pull requests

Every change reaches main through a PR, so the required lane runs on it; none is pushed to main directly. `CONTRIBUTING.md`, "The pull request flow", has the merge command and the bypass line.

## Git hooks

`bun install` points git at `tooling/hooks` (`core.hooksPath`, a relative path, so each checkout and worktree runs its own copy against its own `node_modules`; a checkout without dependencies installed is refused with a message).

- **pre-commit**: formats fully staged files with oxfmt and restages them, only checks partially staged ones, and lints staged files through the ratchet.
- **commit-msg**: strips `Claude-Session:` trailers and claude.ai session URLs; this repo doesn't record them.
- **pre-push**: re-checks format and lint on the files in the pushed commits, then typechecks the changed packages and their dependents (`turbo --filter=...[base...head]`) and runs only the changed packages' fast tier (`--filter=[base...head]`, `--tier=fast`); dependents' tests and the slow tier are CI's job.
- **By hand**: `bun run quality <files…>` (fix), `--check`, `--dirty`, or `--range <a>..<b>`.

Never bypass a hook with `--no-verify`. If one is broken, fix it or say so.

## Linear

All work is tracked in Linear: the luxdev workspace (`linear.app/luxdev`), the Engineering team (`ENG`), the Polaris project.

- **An issue before the work.** For every new request (a feature, a bug, a CI fix, a follow-up), create an `ENG` issue in the Polaris project before you start, or reuse the one that already covers it. Put it on the release it targets in the "Polaris" release pipeline (e.g. Polaris 0.2.0), and keep its status current: In Progress when you start, Done when it lands on main.
- **The issue ID in every commit.** Each commit subject names its issue, e.g. `fix(daemon): a cancel reaches queued requests (ENG-123)`, and so does each merge message. `.github/workflows/linear-release.yml` scans the commits pushed to main for these IDs and attaches the issues to the release in progress; a commit without one is invisible to the release.
- **Agents and branches.** A brief for an agent names its issue and asks for the ID in every commit. Linear's own branch name (`lucas/eng-123-…`) also links the issue, but don't rely on it alone.
- **Follow-ups go in Linear**, not only in a report or a comment: open an issue for anything deferred, linked to the one it came from.

## Performance

Performance is a product requirement: the Daemon must stay light on a Raspberry Pi 4 and a small Linux VM as well as a Mac, and the Desktop App has budgets (< 1 GB total in a heavy session, ≥ 120 Hz, Workspace switch < 100 ms). See `packages/bench/README.md`.

- Before and after a change that could move memory, CPU or latency (engine, store, streams, transport, wire, files, git, terminals, Harness drivers, anything on a hot path or a timer), run the relevant scenarios against the committed baseline for your machine, e.g. `bun run bench sessions history --runs 3 --compare packages/bench/baselines/<machine>.json`. Use `--profile` to see where the time and memory go.
- Never regress a baseline silently: fix the regression, or explain it in the commit and update the baseline (`--save-baseline`) in the same change.
- Anything that wakes an idle Daemon (timers, polling, watchers) must justify itself in the `idle` scenario.
- **Script leases.** `bun run bench` and the Desktop smoke take a Host lease (`tooling/leases.ts`): `bench` and `smoke`, which every Daemon declares at startup with capacity 1 (Settings → Hosts can change it). Outside Polaris they take `/tmp/polaris-<name>-lock`. A new script lease is added to `SCRIPT_RESOURCES` in `apps/daemon/src/resources/model.ts`.

## Verification

The event store, the Engine's streams, recovery and approvals, and the Client's resume are specified in `packages/spec/polaris.qnt` (Quint) and tested against the real code by the model-based tests in `apps/daemon/src/verification/`. See `packages/spec/README.md`.

- A change to the protocol, `apps/daemon/src/engine/`, `apps/daemon/src/store/` or `packages/client/src/resume.ts` that changes how commands are decided, committed, acknowledged, streamed, resumed or recovered must update the spec (and its README mapping) in the same change, and keep the spec checks, the model-based tests and trace validation green.
- Run locally: `bun run spec` (Quint typecheck, scenario tests, simulator), `bun test apps/daemon/src/verification` (model-based tests; `POLARIS_PBT_RUNS=500` for a longer run, `POLARIS_PBT_SEED` to replay a failure), and trace validation as in the spec README. `bun run spec -- --verify` also runs Apalache (Java 17+).
- A bug they find that you cannot fix in the same change goes into `apps/daemon/src/verification/findings.slow.test.ts` as a `test.todo` with a note, and into the spec README's Findings.

## Attribution (required)

Polaris is Apache-2.0. When you copy or adapt code from another project (rather than depending on it):

1. Only copy from permissively licensed sources: MIT, Apache-2.0, BSD, ISC, 0BSD, Unlicense, MPL-2.0 (file-level). **Never copy from GPL or AGPL sources**, and don't read them for code (Waku, Codux, Farcaster are out). herdr is Apache-2.0 only from commit `cd5ea1be` onward; never take anything earlier.
2. Pin the exact upstream commit.
3. Add a header to every file with borrowed code, e.g. `// Portions adapted from pingdotgg/t3code@de251fc (MIT)`.
4. Add an entry to `ATTRIBUTION.md`: source repo, pinned commit, licence, the Polaris files it landed in, and what changed.
5. Run `bun run licenses:check` before committing; it fails on dependencies outside the allowlist.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
