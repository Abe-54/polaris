---
status: accepted
---

# Every change reaches main through the required lane

## Context

CI was slow and mostly red, and a red run blocked nothing, so real breaks sat on main for days
(ENG-735). The baseline, CI from 2026-10-17 to 2026-11-02:

- 200 runs: 59 green, 69 red, 71 cancelled. Of 100 analysed finished runs, 43 were green and
  57 red.
- 48 of the 57 red runs held a real break that landed on main and stayed red for days: Windows
  hard-coded `/tmp`, POSIX file modes, Swift tests on Linux, an archive race, bench module growth.
  9 were red on flakes alone.
- Bench failed 44 times. ENG-735 counted all of them as real regressions; ENG-743 later found its
  memory gate also flaked on shared runners, and now gates on medians of three runs.
- macOS `bun run typecheck` grew from about 2 min to 64-83 min and set the critical path. One
  macOS lint job hung for 6 h.
- Locally, pre-push ran the Daemon suite serially: 548 s over 622 files; 108 s with `--parallel=6`.
  29 files took 312 s of that.
- 65% of commits pull in the Daemon tests.

So the failures were mostly real and the problem was that nothing stopped them, while a gate on a
run that long would have stopped everything else too.

## Decision

**Every change reaches main through a PR that passes the required lane, under 8 min. Everything
else reports.** The lanes, tiers and flow themselves are defined in `CONTRIBUTING.md`, "Checks";
this records why.

- **CI selects only affected packages; main and the nightly run everything.** A PR tests what
  `turbo query affected` names, dependents included, and a root file (`bun.lock`, `tooling/`,
  `.github/` and the like) runs everything, because turbo's lockfile and workspace diffs are
  narrower than what those files can break. A break turbo's graph can't see lands and turns main
  red. The saving is smaller than it sounds, since 65% of commits still run the Daemon tests.
- **Windows is a required OS, though Windows support is experimental**, because many early users
  are on Windows. The hard-coded `/tmp` and POSIX file modes above are the breaks it stops. It
  costs a required job set on the slower runner, and the Windows lane covers the Daemon's suite
  and the remote-only Client's tests, not every package.
- **macOS reports on PRs and counts on main and in the nightly**, because GitHub's macOS queue
  made PR runs take over 30 min. The break a Mac-only test finds lands on main and files a `ci-red`
  issue. Lint and typecheck moved to one Linux run, since macOS typecheck had become
  the critical path. `CI`, the required check, doesn't wait for macOS at all, and `CI (macOS)`
  counts those jobs on a push to main. `needs` can't be conditional, and the alternatives cost
  more: a second job named `CI` for each event still waits on its `needs` before it skips, then
  reports a skipped `CI`, which GitHub treats as passing; a separate workflow needs its own
  `ci-red` and repeats the shared steps.
- **The daemon build the smokes need runs on Linux; only darwin-arm64 needs macOS.** From 14
  green PR runs of 2026-11-02 to 2026-11-06, the build waited for a macOS runner 5.8 min at the
  median, 17.8 at p90 and 25.6 at most, to run for 2.4. The jobs that count finished at a
  median of 12.2 min and a p90 of 23.6 with it, against 10.4 and 16.4 without it and the
  smokes. Keeping it would have left the queue in the lane. darwin needs `codesign`, so it reports
  on the PR with the other macOS jobs.
- **The slow tier runs only in CI** (ADR 0096). pre-push stays under 90 s by running the fast tier
  of the changed packages, so a behaviour only a slow file covers is first checked on the PR.
- **Merge commits, not squash.** Linear's release scan reads the subject of every commit pushed to
  main to attach issues to the release; a squash leaves one subject and loses the rest. The cost
  is a busier `git log`, and a merge subject has to name its issue by hand, since GitHub's default
  doesn't.
- **Quarantine, not retries.** A retry turns a flake green and leaves it there, and adds its time
  to every red run. A quarantine entry names the test, carries an issue and expires after 30 days
  (`bun run lint` enforces both), and the nightly keeps running it. Until it is fixed, the required
  lane does not check that behaviour.
- **An admin bypass stays, on the record.** It needs a `ci-bypass: <reason>` line in the merge
  message, and the nightly lists each one.
- **A red main or nightly files one rolling `ci-red` issue per failing job**, since by then no gate
  can stop it.

## Consequences

- A quarantine entry going past 30 days fails `bun run lint`, and so the required lane of every
  open PR, whatever it changed. That is deliberate: the expiry has to cost something.
- On the PR that made this change, `CI` reported at 8.2, 8.3 and 6.8 min with macOS jobs still queued,
  and failed on a failed counted job. The Linux build took 1.5 min.
- `CI` on main doesn't include macOS: a green `CI` beside a red `CI (macOS)` means main is red,
  and the run says so. Nothing reads `CI` on main; branch protection reads it on the PR.
- A darwin build break, like a Mac-only test failure, lands on main. CI's smokes also run binaries
  cross-compiled on Linux, while a release builds on macOS, so a fault only that build has first
  shows at release.
- A macOS job cancelled on its own now files a `ci-red` issue, as main's run 41862561967 (six macOS
  jobs cancelled, nothing filed) should have. Queued macOS jobs were cancelled after 20 to 32 min
  without a runner on this change's PR, so a queue can file these too. Cancelling a whole run
  still files nothing.
- PR macOS jobs keep their place in the queue after the PR merges, and report on a closed PR.
- The budgets (pre-commit 10 s, pre-push 90 s, the required lane 8 min) are targets that nothing
  enforces; a miss needs someone to notice it and open an issue.
- `CONTRIBUTING.md` describes branch protection and auto-merge as not yet on until ENG-738 turns
  them on, and changes in the same step.
