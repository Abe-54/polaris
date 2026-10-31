# CPU Profiles validation (ENG-657)

P4 adds CPU capture and restart, retained Profile details, snapshots and the `profile`
MCP tool on the integration base `c4a1ce26f2a8820181b874b28166ee809b8fba6f`.
The optional `origin` and `service` fields match P5's definitions; `cwd` records the
verified execution directory while ownership and retention remain checkout-scoped.

## Behavior and boundaries

- Node and Bun run directly from argv in the verified Agent Session cwd, including
  package subfolders. Runtime profiling options select a private output directory.
- Only this service's live subprocess handles authorize restart. Unknown, user-shell
  and previous-Daemon PIDs return `E-PROFILE-PROCESS-NOT-OWNED`, the exact P5 message
  and a fix telling the agent to ask the user. Original cwd containment, session
  policy and existing Workspace Trust are checked again before restart.
- Each new launch obtains a fresh tracing overlay from the original source environment
  and invoking Turn. The complete overlay survives, including P3's internal variables.
- `profiles.watch`, `get` and `restartWithProfiling` are implemented and
  `traces.profiles` is advertised. Reads remain available for untrusted, plan,
  policy-read-only and Reviewer Agent Sessions; execution is refused.
- A one-shot worker validates, parses and aggregates CPU graphs. The function table
  sorts by total time, nodes retain earlier parents, paths are checkout-relative
  where possible, and the hot path accumulates separated samples of the same stack.
- Retention prunes on access/completion, with seven days, 200 MiB per checkout and
  200 recordings. Raw and cached details count together. Reads never pin; no idle
  polling was added. Raw artifacts retain their native contents; parsed names and
  locations use the Traces scrubber.
- P9's scoped `Profiles.record` allocates storage and finalizes on successful scope
  close; failure or interruption discards it. It grants no PID adoption or restart
  authority. The contract is in `apps/daemon/src/traces/profiles/README.md`.

## Checks

All final broad checks, builds and benchmarks ran serially under the existing Host
`lease bench`; no parallel compiler or benchmark was started by P4.

| Check | Result | Local receipt |
| --- | --- | --- |
| Final root typecheck, concurrency 1 | 18/18 tasks; 17 cached | `/tmp/p4-root-typecheck.log` |
| Traces and MCP suites | 237 pass, two existing DB skips, 0 fail; 2,148 assertions, 41 files | `/tmp/p4-traces-mcp-final.log` |
| Final capture/restart tests after fixture typing correction | 12 pass, 0 fail; 129 assertions | `/tmp/p4-profiles-final.log` |
| Final root lint | Passed without baseline changes | `/tmp/p4-root-lint.log` |
| Platform build | darwin-arm64, actual build script, native-library self-checks passed | `/tmp/p4-build.log` |
| Compiled-worker RPC smoke | Real Node profile, 107.416 ms, 13 functions, 24 nodes; missing detail cache rebuilt | `/tmp/p4-compiled-smoke.log` |

The full root test attempt was **not green**: 17/19 tasks succeeded before Turbo
stopped. Daemon reported 3,220 pass, 87 skip, eight failures and six between-test
errors. Seven failures were unchanged `git/log.test.ts` and `git/sync.test.ts`
five-second timeouts during a Host load burst (53.87 on 12 cores). Their unchanged
isolated rerun under the same lease passed 23/23, 52 assertions, with load 9.62.
The eighth failure was the shared catalog's assumption that every direct tool
submits idempotent Constellation commands. Its exception list now records the
Profile tool's direct-execution contract; the final MCP suite passed. No timeout
was loosened. The Desktop test task did not complete in that broad attempt.
Logs: `/tmp/p4-root-test.log`, `/tmp/p4-git-recheck.log`,
`/tmp/p4-git-recheck-load.log`. The two skipped MCP integrations require real
PostgreSQL/MySQL configuration; no live database run is claimed.

Initial typecheck/quality failures were corrected before the final runs. The first
build lacked two lockfile-pinned optional native packages; a frozen all-platform
dependency install resolved them without manifest/lockfile changes. Two validation
script import errors were corrected before the successful compiled smoke.

Negative controls separately restored the previous longest-contiguous-frame hot
path and removed pending-child shutdown tracking. Each named regression failed;
restoring the implementation made it pass. Receipts: `/tmp/p4-negative.log`,
`/tmp/p4-negative-restored.log`, `/tmp/p4-shutdown-negative.log`,
`/tmp/p4-shutdown-restored.log`. No mutation remains.

## Large profiles and compiled packaging

The focused worker test parsed an exact 50,000,000-byte synthetic artifact containing
one million samples in 366.359 ms. Its main-process heartbeat ran 31 times, with a
13.638 ms maximum gap. The broad-run measurement was 322.342 ms and 12.051 ms.

The actual `scripts/build-daemon.ts darwin-arm64` ran from a disposable shadow root
whose source and dependencies point to this worktree. Only its build output lived
there; the script included the added Profile worker entrypoint. The resulting
binary ran with a short disposable `/tmp` POLARIS_HOME. Via local socket RPC,
`profiles.get` rebuilt a real Node artifact and advertised `traces.profiles`.
The same binary parsed the exact 50 MB synthetic artifact in 232.155 ms while
19 independent `files.stat` RPCs completed: p50 0.549 ms, p95/max 1.547 ms.
The synthetic measurement tests payload parsing, not a 50 MB real workload capture.

Build output: `/tmp/p4-build-2c1zof53/apps/daemon/dist/darwin-arm64/polaris`.
Reproduction: `bun docs/specs/profile-smoke.ts /tmp/.../polaris` (inside the Host
lease). The script removes its home and Workspace and stops its Daemon. No build
was installed; `polaris install` and `polaris upgrade` were never run. No Desktop
App was launched.

## Idle comparison

The exact committed base archive (`c4a1ce26`, `/tmp/p4-base-5iqqd6vx`) and final
source ran three standard idle scenarios each against
`packages/bench/baselines/mac14-13-apple-m2-max-12c.json`. Both commands exited 1
with the same four memory regressions against that older baseline. No baseline
was changed. Their medians are:

| Metric | Committed baseline | Base | P4 |
| --- | --- | --- | --- |
| Client RSS, MiB | 94.453125 | 107.968750 | 108.281250 |
| Client physical footprint, MiB | 52.844482 | 65.016380 | 65.063278 |
| No-client RSS, MiB | 68.328125 | 107.984375 | 108.250000 |
| No-client physical footprint, MiB | 54.000755 | 64.703880 | 64.688278 |
| No-client CPU, % | 0.029226 | 0.017010 | 0.017160 |
| No-client wakeups, /s | 0.766616 | 0.599955 | 0.599975 |
| Client CPU, % | 0.157184 | 0.507424 | 0.550839 |
| Client wakeups, /s | 8.233042 | 8.066106 | 8.099845 |

Relative to the same integration base, P4 adds 0.3125 MiB client RSS and 0.046898 MiB
physical footprint; no-client footprint decreases 0.015602 MiB. These measurements
do not establish a memory regression caused by P4, nor a green baseline gate.
The runner warned of 2.2 and 2.9 busy cores before the respective runs, so CPU
results are not a quiet-Host claim. Receipts: `/tmp/p4-idle-before.json`,
`/tmp/p4-idle-after.json`, corresponding `.log` files and
`/tmp/p4-perf-status.json` (`build:0, smoke:0, before:1, after:1`).

## Remaining scope

P4 does not attach to an existing process or adopt Terminal/Harness processes.
P2/P9's authenticated launch registry can replace the local retained-handle lookup
in `Profiles.restart`; no shared registry was introduced here. In-flight captures
from a previous Daemon become failed. Child-process CPU artifacts are not aggregated.
No Raspberry Pi, Linux release build or production inspector attach run is claimed.
