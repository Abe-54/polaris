# ENG-673 validation and measurements

Native Mac14,13, Apple M2 Max (12 cores), macOS 27.0, Bun 1.4.4,
2026-10-31. Final checks ran sequentially under the Host's `bench` lease,
with the repository's default timeouts.

## Correctness

- Root typecheck: 18/18 tasks passed, 17 cached; the Daemon was checked fresh.
- Root lint and changed-file quality checks passed.
- Traces, Harness and terminal suites: 525 passed, 22 skipped, none failed;
  1,848 assertions across 95 files.
- Full Daemon suite: 3,207 passed, 87 skipped, one failed; 99,071 assertions
  across 569 files. The failure is the existing ENG-683 relay sent-outcome
  assertion at `push/push.e2e.test.ts:313`. Its isolated default-timeout recheck
  passed all 21 assertions. The full suite is not reported as green.
- Disabling only `applyClaudeTraceHooks` through a temporary Bun preload makes
  the real Bash regression fail: `turn` remains Turn 5 but `launchedTurn` is
  null instead of Turn 2. The command exits successfully and exports through
  the real receiver/worker/SQLite path. The negative control took 349 ms and
  changed no working-tree source.

The positive regression uses FakeClaude at the SDK boundary and a real Bash
child. Its Spans cover Turn 5 and the interval between Turns while retaining
launch Turn 2. A real PTY terminal command exports with Workspace authority and
null Turn attribution. Other regressions cover token tampering, cross-session
signature substitution, reload/revocation, no per-command vault growth, unknown
Codex launches, unbound Subagents and callbacks after Harness scope close.
Live vendor Model runs and Windows launch hooks were not exercised.

An earlier repo-wide test attempt was stopped during the Host's out-of-memory
incident after unrelated language-catalog fixture failures. It does not establish
a passing monorepo test run. Earlier higher-timeout focused results are superseded
by the default-timeout leased checks above.

## Terminal comparison

Both sources used `terminal --quick --runs 3` against the unchanged committed
`mac14-13-apple-m2-max-12c-quick.json` baseline. The control is an unmodified
`git archive c4a1ce26f2a8820181b874b28166ee809b8fba6f` snapshot sharing only
the checkout's pinned dependency directories. It has no `.git`, so its raw
`gitSha` field is empty. The after results record the dirty c4a1ce26 tree whose
product changes are committed with this report.

| Median | Committed baseline | Unchanged c4a1ce26 | P2 |
| --- | ---: | ---: | ---: |
| Throughput, MB/s | 17.31 | 15.83 | 15.90 |
| Stream, ms | 593.3 | 648.7 | 645.8 |
| CPU, % one core | 103.3 | 110.1 | 111.1 |
| Peak RSS over initial, MiB | 21.00 | 36.09375 | 36.09375 |
| Peak footprint over initial, MiB | 12.49 | 33.62589 | 33.23524 |
| RSS after close, MiB | 119.7 | 134.3125 | 133.671875 |

**Both comparisons exit 1:** peak RSS and footprint fail the historical gates.
The unchanged control and P2 have identical median RSS growth, and P2's median
footprint growth is lower. These measurements do not establish a new memory
regression from launch attribution. They also do not turn the failed historical
gates into passing checks. ENG-427 already tracks the Mac baseline's terminal
peaks and failure to reproduce. No baseline or tolerance was changed.

The control and P2 reported 2.7 and 3.0 busy background cores respectively;
the runner warns that CPU and throughput are not comparable to a quiet baseline.
Raw samples and ranges are in `terminal-base.json` and `terminal-after.json`.

## Traces and initial Host pressure

One quick Traces run completed 20,000 Spans at 29,976.68 Spans/s, with
667.19 ms ingest, 11.22 ms concurrent RPC p99, 145.92 MiB peak RSS growth and
261.4 MiB RSS after quiet. The quick baseline has no Traces rows: these are
new observations, not passing performance comparisons. The run reported 2.5
busy background cores. `traces-after.json` also retains its single terminal run,
whose two memory gates failed before the three-run paired comparison above.
This scenario uses a session endpoint; it does not measure the extra serialized
bytes of non-null launch attribution at high Span volumes.

The first unchanged-base run occurred during Host memory pressure, reporting
6.6 busy cores. Traces failed because the Daemon did not answer within 30 seconds;
terminal throughput was 0.551 MB/s. `initial-base.json` preserves that failed run.
It is not used to infer a performance improvement. The operator reported load
210 on 12 cores, 66 MB free memory and 12.7/14 GB swap during the incident.

ENG-691 tracks a future Codex per-command hook. ENG-683 tracks the isolated push
log race. ENG-427 tracks the unresolved historical terminal benchmark gates;
ENG-682's separate full-size Traces RSS/footprint investigation remains open.
