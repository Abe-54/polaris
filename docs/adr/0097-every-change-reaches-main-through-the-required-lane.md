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
- **A job no runner acquired has no result, so it is neither red nor green.** GitHub cancels such a
  job with no steps and the annotation `The job was not acquired by Runner`. From 2026-10-26 to
  2026-11-06 that hit 8 CI runs on main (6 of the 70 that finished, 2 cancelled whole), 2 of 4
  nightlies and 13 of 39 finished PR runs, 46 jobs in all, and a job took a median of 20 min and a p90
  of 33 to be cancelled. Steps
  count alone can't tell: a job timeout (run 40980865529) also has none, so the annotation decides
  and a job that ran steps can't claim it. `CI (macOS)` then skips rather than fails, since short of
  cancelling the run a job has no other conclusion to take, and on a push to main nothing else skips
  it. Passing would claim a result, and failing would blame a test. Unsure stays red: without the annotations, the job
  counts as cancelled.
- **Main re-runs those jobs once, and only when nothing else is red.** This isn't the retry the
  quarantine rules out: no step ran, so nothing can turn green that had failed. GitHub's re-run takes
  every failed job, though, so any other red job blocks it. All 8 CI runs above had another red job,
  so none would have re-run, while 1 of the 2 nightlies would; main was red for other reasons then,
  and the next push runs every macOS job again. One re-run, not more, for two reasons: of the 204
  macOS jobs queued in the 20 min after such a cancel, 187 got a runner, and a run restarted with
  `GITHUB_TOKEN` may not fire `workflow_run` again, so only the first re-run can be counted on.
  `ci-rerun.yml` is its own workflow because a run can't re-run itself before it finishes.
- **A PR's report-only macOS jobs run only when its own files need them.** GitHub has no queue
  priority, and macOS capacity is the limit rather than the org's five slots: from 17:05 to 18:35 on
  2026-11-06, 25 to 37 macOS jobs sat queued while about two ran. Since ENG-781 PRs took 203 of 266
  macOS runner-minutes, and main's macOS jobs waited a median of 32.7 min, p90 50.8, max 66.9 (21
  jobs that had started; 26 more were still queued, up to 81.9 min). A two-slot FIFO replay of those
  arrivals reproduces that (median 35.3, p90 50.7). With the gate it gives a median of 3.4 and a p90
  of 7.2, against 2.4 and 7.0 with no PR macOS jobs at all, since 10 of those 16 PR runs drop out. It
  does nothing when PRs touch macOS code: on 2026-11-02 it kept 12 of 13, and the median stays 19.2.
  Over the whole period it keeps 26 of 41. Fewer shards save no runner-minutes; skipping only parts
  that aren't affected saves about 5 of those 203; cancelling a merged PR's jobs saves about 4, and
  would need a write token on main's run. The cost is that a Mac-only break in a file the gate misses, such as a test
  file, first shows on main, which is where such a break already landed: 6 of the 7 macOS-only job
  failures since 2026-11-02 were on main.
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
- A macOS job cancelled after a runner took it files a `ci-red` issue. One no runner acquired doesn't:
  main's run 41862561967 (six such jobs beside a real Windows failure) now files the Windows failure
  and one `no runner` issue naming no test. Cancelling a whole run still files nothing.
- GitHub marks a run with a job no runner acquired as failed, whatever `CI (macOS)` says, so a count
  of main's runs reads `CI` and `CI (macOS)`, where skipped on a push means no result.
- Runner capacity stays GitHub's: the gate shortens main's queue, but 2026-11-04 lost all 11 macOS
  jobs of two runs with no queue at all, and a re-run into that gets no runner either.
- PR macOS jobs keep their place in the queue after the PR merges, and report on a closed PR.
- The budgets (pre-commit 10 s, pre-push 90 s, the required lane 8 min) are targets that nothing
  enforces; a miss needs someone to notice it and open an issue.
- `CONTRIBUTING.md` describes branch protection and auto-merge as not yet on until ENG-738 turns
  them on, and changes in the same step.
