# @polaris/lint-config

The shared [oxlint](https://oxc.rs/docs/guide/usage/linter) configuration (`oxlint.json`), the shared [oxfmt](https://oxc.rs/docs/guide/usage/formatter) style (`oxfmt.json`), and the custom oxlint plugins under `plugins/`. Every workspace has a `.oxlintrc.json` that extends `oxlint.json`, and so does the repo root (for `scripts/` and anything outside a workspace).

`bun run lint` runs oxfmt's format check (`oxfmt --check`), then the lint ratchet (`tooling/lint/ratchet.ts`), which runs oxlint over the repo and compares the result with the committed baseline.

## Formatting

`oxfmt.json` is the house style, kept in step with sightline's: 2-space indent, semicolons, double quotes, `trailingComma: "es5"`, `package.json` key order left alone, imports not sorted (sightline doesn't sort them either). The one difference is `printWidth`: 100 rather than sightline's 80, because `max-lines` (750) was set against 100-column code and rewrapping at 80 pushes six files over it through formatting alone. The root `oxfmt.config.mts` spreads it and adds Polaris's ignore paths, because oxfmt resolves `ignorePatterns` against the config file's own directory; it's found automatically, so `bun run format`, `oxfmt <files>` and editors all use it. oxfmt applies the ignores to explicit file arguments too.

## The rules

All at `error`. Type-aware rules run through `oxlint-tsgolint`, which uses the TypeScript 7 native compiler.

- **Correctness**: oxlint's `correctness` category.
- **TypeScript safety**: `no-explicit-any`, `ban-ts-comment`, `no-non-null-asserted-optional-chain`, `no-unsafe-*`, `no-floating-promises`, `no-misused-promises`, `await-thenable`, `only-throw-error`, `no-unnecessary-type-assertion` and friends (see `oxlint.json`). The `no-unsafe-*` rules are off for plain `.js`/`.mjs` files, which have no types to check.
- **`max-lines`**: 750 per file, blank lines skipped, comments counted.
- **`sonarjs/cognitive-complexity`**: 15 per function.
- **`polaris/no-long-comment`**: at most two lines of prose per comment.
- **`polaris/no-fixed-sleep`** (`plugins/polaris/fixedSleep.mjs`): in test files and test helpers (`*.test.*`, `*.testing.*`, `testing.ts`, `testing/`), no fixed sleep over 50 ms. See below.
- **`polaris/await-expect-promise`**: an `expect(…).rejects` / `.resolves` statement must be awaited. bun types the matcher as `void`, so write `await Promise.resolve(expect(p).rejects.toThrow(…))`; unawaited, the assertions after it run before the promise settles.
- **`polaris/effect-cleanup-return`**: a `useEffect` / `useLayoutEffect` / `useInsertionEffect` callback is never `async` and has a block body, unless its expression body is a function, an identifier (a cleanup) or `void …`. React calls whatever an effect returns as its cleanup; Chromium's scroll methods return a Promise though the DOM types say `void`, so `() => el.scrollIntoView()` threw on unmount and blanked the window (ENG-756). Write `{ return subscribe(); }` when the call returns a cleanup.
- **`polaris/no-ptr-argument`** (`plugins/polaris/ptrArgument.mjs`): `bun:ffi`'s `ptr(…)` (however imported) is never a direct call argument; pass the typed array, or a subarray or view for an offset (ADR 0066). `ptr()` roots nothing, so the buffer can be collected before the call reads it. Storing an address (`BigInt(ptr(x))`, a `const`) stays allowed where a later call keeps its memory alive.
- **`polaris/child-env`** (`plugins/polaris/childEnv.mjs`, exceptions in `childEnvAllowlist.mjs`): in `apps/daemon/src/`, every `Bun.spawn`/`spawnSync`, `node:child_process` launch and Claude Agent SDK `Options` literal passes `env:` from `childEnv(…)` or a builder over it (`harnessEnv`, the `security/repository-env` builders), directly, through a const or a spread options const, or as a literal object that inherits nothing. Bun's default env keeps `POLARIS_HANDOFF` after the Daemon deletes it (ENG-269). `Bun.Terminal` takes no env; its shell starts through `Bun.spawn`. The `security/repository-env` modules are exempt (childEnv is forbidden there); tests and test helpers are exempt.
- **anti-slop**: every generic rule, the native companion `oxc/no-accumulating-spread`, and every Effect rule.
- **security**: the guards from the October 2026 security audit (see below and `docs/security/README.md`).

## security (`plugins/security/`)

Five rules, each scoped by repo path, with its sanctioned call sites in `allowlist.mjs` (one comment per entry says where the bytes, config or environment come from). Test files, `testing` helpers, `.fixture` and `.bench` files are exempt. Adding an allowlist entry is a security decision: get it reviewed.

- `security/git-spawn` (`apps/daemon/src/`): git is started only through `git/git.ts`. It reports `Bun.spawn`/`spawnSync`, `child_process` spawns and execs, and Bun's `$` whose command is git (a literal, a path ending in `/git`, a const holding one, or `which("git")`), plus `which("git")` itself. An entry marked `safe` must also call `safeConfigEnv`, or the file is reported.
- `security/spawn-path` (`apps/daemon/src/`): programs start by their absolute path (ADR 0070). It reports a spawn whose program is a bare-name literal (or a const holding one), and a spawn with a `cwd` option, a spread or an options variable whose program isn't `executableOf(…)`, `gitExecutable(…)`, a whole `launchArgv(…)`, an absolute literal or `process.execPath`; plus `Bun.which`, which only the `resolver` entry may call. A `resolved` entry resolves its argv where the rule can't see; bare literals still report there.
- `security/git-config-mode` (`apps/daemon/src/`): `config: "host"` or `"trusted-fetch"` (also inside a conditional or `as const`) only in git the user asked for (ADR 0056).
- `security/image-decode` (the renderer, `shared/`, `@polaris/ui`): `new Image`, `new ImageDecoder`, `createImageBitmap`, `URL.createObjectURL`, a no-argument `.decode()`, `createElement("img")` and value imports of `mermaid` / `@streamdown/mermaid` only where the bytes were admitted (`admitRaster`) or Mermaid is wrapped in `guardedDiagrams`. JSX `<img src>` isn't checked; its URL comes from one of these.
- `security/repository-env` (the modules that start a repository's code: worktree setup, the Reviewer's confinement and env, the Rules layer's git and Betterleaks): `process.env` only as an argument to `repositoryEnv`, `setupEnv` or `readOnlyEnv` (or a parameter default, or one variable read); no `childEnv` (the Daemon's whole env); every spawn passes `env`.

The Desktop App's `no-restricted-globals` rule on `fetch` in `src/main/` (`apps/desktop/.oxlintrc.json`) is the fifth guard: Main's internet goes through `internetFetch` (ADR 0053). `tooling/security/` tests it, and that every external GitHub Action is pinned to a commit SHA.

## The ratchet

Existing violations are recorded in `tooling/lint/baseline.json` as counts per file and rule. `bun run lint` fails when a file's count for a rule goes above its baseline, which covers a new violation in an old file, any violation in a new file, and any rule a file wasn't breaking before.

- `bun run lint` checks the whole repo. `bun tooling/lint/ratchet.ts <files…>` checks just those files; the git hooks use that.
- `bun run quality <files…>` fixes before it checks: `oxlint --fix` from the repo root (every `.oxlintrc.json` and plugin applies; only safe fixes), then oxfmt, then the ratchet. The pre-commit hook only formats, so lint fixes never land in a commit unseen; `--check` changes nothing.
- When you fix baselined violations, lint says so. `bun run lint:baseline` then lowers the counts (and drops fixed or deleted files). It never raises a count or adds an entry.
- Commit the lowered baseline with the fix. Merge conflicts in `baseline.json` resolve by taking the lower count, or by running `bun run lint:baseline` after the merge.
- Renaming or splitting a file drops its baseline entry, so the new file must be clean. That's deliberate: the split is the moment to fix it.
- `--rebaseline` rewrites the baseline from scratch, loosening it. It exists for adding a new rule (record what the rule finds today, then ratchet it down). Say so in the commit message; never use it to get a change past lint.

## Policy

- **No disable comments** for `max-lines` or `sonarjs/cognitive-complexity`. If a case is genuinely irreducible, raise the policy, don't add an escape hatch. For the other rules, an `oxlint-disable-next-line` needs a reason on the same line, and a reviewer should push back.
- Comments count toward `max-lines` on purpose: a file doesn't get to be bigger because it explains itself in prose.
- Split a long file along its seams (a folder whose `index.ts` is the module's interface), not by size. No `utils.ts` dumping grounds.

## `polaris/no-long-comment` (`plugins/polaris/index.mjs`)

Caps a comment at **two lines of prose**. Long rationale in a source comment drifts out of date and has nowhere to record that the decision changed; that belongs in an ADR under [`docs/adr/`](../../docs/adr/).

A "comment" is a block comment, or an unbroken run of `//` lines that each own their line: a run of ten `//` lines is **one** violation. These lines don't count toward the cap:

- blank lines inside the comment;
- reference lines: `See docs/…`, a bare URL, a ticket id like `ENG-123`;
- tooling directives: `eslint-disable`/`oxlint-disable`, `@ts-expect-error`, `prettier-ignore`/`oxfmt-ignore`, and the `SAFETY:` line that `anti-slop/require-safety-comment-for-type-assertion` asks for.

JSDoc (`/** … */`) documents an API surface and is exempt. Trailing comments (code before them on the line) are never grouped or reported. A hashbang is not a comment.

Fixing a violation: if the comment explains **why**, write an ADR and leave a pointer; if it explains **what**, make the code say it (rename, extract); if it warns about a **trap at this call site**, keep it, in two lines. `MAX_PROSE_LINES` is the knob; raising it is a decision about the codebase, not a workaround.

## `polaris/no-fixed-sleep` (`plugins/polaris/fixedSleep.mjs`)

A fixed sleep in a test is slow when it's long enough and flaky when it isn't. Wait on a condition (poll, an event, a `Deferred`), or use `TestClock` for time the code under test measures.

It reports a sleep whose duration is a literal or a `const` in the same file (`60 * 1000`, the longer branch of `a ? 500 : 10`, `"2 seconds"`, `Duration.seconds(2)`) above `MAX_SLEEP_MS` (50):

- `Bun.sleep`, `Bun.sleepSync`, `Effect.sleep`;
- `sleep(n)`, `delay(n)` and `setTimeout(n)` (`node:timers/promises`), and any local helper that passes its first parameter to a sleep, whatever its name;
- `new Promise((r) => setTimeout(r, n))`, when the timer is all the executor does.

These don't count: `Effect.sleep` in a file that imports `TestClock`, a sleep directly inside `Promise.race`/`any` or `Effect.race`/`raceAll`/`raceFirst` (it bounds a wait), and a timer that rejects or schedules work.

It can't see an imported constant, a computed duration, an aliased helper or `Effect.delay`. Proving that something does not happen sometimes needs a real wait; keep those at 50 ms or under, or disable the line with the reason.

## `sonarjs/cognitive-complexity` (`plugins/sonarjs/index.mjs`)

A one-rule wrapper around [`eslint-plugin-sonarjs`](https://github.com/SonarSource/SonarJS) (LGPL-3.0-only, a dev dependency pinned exactly, never shipped in the Daemon or Desktop App). oxlint has no native cognitive-complexity rule, and its `complexity` rule is cyclomatic, which punishes flat switches and lets deep nesting through. Only `cognitive-complexity` is registered.

## anti-slop (`plugins/anti-slop/`)

A vendored copy of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT); provenance and update steps are in `plugins/anti-slop/UPSTREAM.md`. It is meant to be owned, not consumed: edit it to fit us and re-diff against upstream when pulling changes. It is excluded from oxfmt and from lint so its bytes stay close to upstream.

The Effect rules, with the reason for each:

- `anti-slop-effect/no-manual-tagged-construction`: build tagged values with their Schema `.make`, class constructor or `Data.taggedEnum` constructor, so the value is checked and the tag can't be misspelled.
- `anti-slop-effect/no-manual-tag-comparison`: branch on tags with `Match.tag`/`Match.tags` (or `Predicate.isTagged`) rather than `x._tag === "…"` or a `switch`, so exhaustiveness is checked.
- `anti-slop-effect/prefer-effect-match`: a chained literal ternary over one value is a `Match` waiting to happen.
- `anti-slop-effect/no-manual-effect-error-tag`: handle tagged errors with `Effect.catchTag`/`catchTags` (or `catchReason`), not by inspecting `_tag` inside a broad catch handler.
- `anti-slop-effect/no-service-constructor-imports`: don't import a `make<Service>` constructor into runtime code (tests may); yield the service and let its Layer provide it. Only relative imports are checked.

The generic rules that matter most day to day:

- `require-safety-comment-for-type-assertion`: every non-`as const` assertion needs a `// SAFETY: …` line stating the invariant that makes it true.
- `no-unknown-parameters` / `no-unknown-returns`: parse at the boundary (Effect Schema) instead of passing `unknown` around.
- `no-runtime-typeof`: same idea; narrow with a schema at the I/O edge, not `typeof` in the middle of the program.
- `no-object-parameters`: a function (including an `Effect.fn`) takes an owner-provided, named input type parsed at its boundary, not an inline object type.
- `no-known-value-widening`: `const x: Record<string, T> = { … }` throws away the known keys; prefer inference or `satisfies`.
- `no-module-mocking`: no `vi.mock`/`jest.mock`-style module mocking; replace dependencies through a real seam (a Layer).
- `require-readable-spacing`: blank lines between statement groups. Autofixable: `bun run quality <files…>` applies it; oxfmt keeps the blank lines it adds (it only collapses runs of blank lines to one), so the two never fight.

## Caught errors

A `catch` binds `unknown`, and the anti-slop rules (`no-unknown-parameters`, `no-known-value-widening`, SAFETY comments on assertions) reject the quick ways of narrowing it. Judgement, not a rule: decode it at the catch with Effect Schema instead.

- To log it, use `errorInfo` in `apps/site/lib/log`: `Function.flow(Schema.decodeUnknownOption(Schema.instanceOf(Error)), Option.match({ onNone, onSome }))`, where `onSome` is a typed helper taking an `Error` and returning only safe fields (the type name and an HTTP status, never the message).
- To branch on a known error, decode against its class: `const decodeTimeout = Schema.decodeUnknownOption(Schema.instanceOf(ValidationTimeout))`, then `if (Option.isSome(decodeTimeout(error)))` (as in `apps/site/app/api/email/_lib/validator.ts`).
- No `catch (error: any)`, `error as Error` or `typeof`/`in` probing; a typed helper takes the decoded value, not `unknown`.

## Fixtures

`bun run test` (or `bun test` in this package) runs `plugins/fixtures.test.ts`, which lints each plugin's `test/fixtures/` with its `test/fixtures.oxlintrc.json`: the clean fixtures must be silent, `long-comment.ts` must report exactly four groups, and `complex.ts` exactly one function. The security fixtures plant each violation once (one report per line) beside allowlisted and exempt files that must stay silent; their config passes its own `scope` and `allow`. To eyeball one by hand:

```sh
cd packages/lint-config/plugins/polaris/test && ../../../../../node_modules/.bin/oxlint -c fixtures.oxlintrc.json fixtures
```

## Bumping oxlint

oxlint's JS plugin API is ESLint-compatible but alpha and outside semver, so every plugin here can break on a minor bump.

1. `oxlint` (root) and `@oxlint/plugins` (this package) must be the **same exact version**; bump them together. `oxlint-tsgolint` (root) must support the TypeScript version in use (its major tracks TypeScript's, `7.0.x` for TypeScript 7.0).
2. Run `bun run test` here (the fixtures) and `bun run lint` at the root. A plugin that fails to load shows up as an oxlint error, not as silence, but check the violation counts didn't collapse to zero.
3. If a bump changes what a rule reports, the ratchet shows it: new findings fail lint (fix them or discuss), fewer findings mean `bun run lint:baseline`.
4. `eslint-plugin-sonarjs` is bumped deliberately, alongside oxlint, with the same checks.

The anti-slop plugin is TypeScript, loaded through Node's type stripping, so the oxlint JS host needs Node ≥ 22.18 on `PATH` (CI installs Node 24).
