---
status: accepted
---

# Tests split into a fast and a slow tier

## Context

pre-push ran every test of the changed packages. A Daemon-only push ran the whole Daemon suite,
minutes on a loaded Mac, because a few dozen files (real Daemon processes, real git, model-based
runs) take most of the time. Pushes waited on work CI repeats anyway (ENG-737).

## Decision

**A test file named `*.slow.test.ts` (or `.tsx`) is slow-tier; every other test file is
fast-tier, with a budget of 2 s.**

- **What is slow.** A real Daemon process, real network or SSH, heavy real git (many repos or
  worktrees), model-based or property runs (fast-check, `*.model.slow.test.ts`,
  `*.graph.slow.test.ts`, `apps/daemon/src/verification`), Quint, or a file over 2 s.
- **Who runs what.** `tooling/test/watchdog.ts` takes `--tier=fast|slow|all` (default `all`).
  pre-push passes `--tier=fast`; CI runs `all` on every OS.
- **The budget.** A run that includes the fast tier ends by listing the fast files over 2 s, and
  under GitHub Actions adds the list to the job summary. It only warns: per-file times on a
  loaded Mac or a shared runner swing by 2-3x, so any failing threshold would be flaky. The fix
  for a listed file is to speed it up or rename it.
- **Selection.** The fast tier ignores `**/*.slow.test.*`. bun's globs have no negated groups, so
  the slow tier ignores names not ending in `.slow` one character at a time
  (`tooling/test/tier.ts`), which keeps any path filters a package script passes.

## Consequences

- A behaviour covered only by a slow file is no longer checked before a push; CI catches it.
- Renaming a file to `.slow` must update what names it: `ci.yml`'s Windows list, the spec README's
  mapping, `tooling/lint/baseline.json`.
