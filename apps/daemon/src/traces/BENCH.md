# ENG-656 measurements

Native Mac14,13, Apple M2 Max (12 cores), Bun 1.4.4, source Daemon. Three runs
per scenario, 2026-10-31. These are observations on a busy workstation, not a
quiet-machine throughput baseline. The stored trace result records the dirty
pre-commit tree on d8ed185d; it contains the final decoder and redaction code.

## Idle

Command:

```sh
bun run bench idle --quick --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-m31-idle-quick.json
```

The comparison reported **no regressions beyond tolerance**. The old baseline
started with 4.4 busy cores and this run with 5.7. CPU/throughput comparisons carry
the runner's warning. Before implementation the same command also passed.

| Metric | Baseline | Before | After median | After range |
| --- | ---: | ---: | ---: | ---: |
| Client CPU, % one core | 0.519 | 0.636 | 0.492 | 0.339–0.615 |
| Client footprint, MiB | 98.11 | 64.30 | 66.87 | 64.45–66.99 |
| Client wakeups/s | 13.10 | 10.00 | 9.10 | 8.30–10.00 |
| No-client CPU, % one core | 0.363 | 0.249 | 0.168 | 0.162–0.214 |
| No-client footprint, MiB | 97.19 | 63.99 | 66.67 | 66.00–66.95 |
| No-client wakeups/s | 10.50 | 7.70 | 6.30 | 6.10–6.90 |
| Processes | 1 | 1 | 1 | 1–1 |

Client peak CPU was 6.14% versus 1.33%, an informational, non-gating metric.
No polling, worker or flush timer is created by an unused receiver.

## 200k Spans

Command:

```sh
bun run bench traces --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c.json
```

200 batches of 1,000 JSON Spans each, through the real receiver and SQLite
worker. Each batch runs beside a `files.stat` RPC. A final Trace read verifies
1,000 Spans and flushes pending writes; memory is sampled again after 32 seconds
of silence. The new scenario has no historical measurement: every comparison
row is **new**, so the runner's “no regressions beyond tolerance” is not a claim
of unchanged ingest performance. This run started with 11.1 busy cores.

| Metric | Median | Range |
| --- | ---: | ---: |
| Spans/s | 13,323 | 7,460–16,510 |
| Ingest ms | 15,012 | 12,114–26,810 |
| CPU, % one core | 91.53 | 59.12–106.9 |
| Peak RSS over initial, MiB | 153.1 | 135.6–162.5 |
| RSS after quiet, MiB | 184.8 | 108.6–268.3 |
| Concurrent RPC p99, ms | 16.34 | 3.31–18.41 |

Raw result: `packages/bench/baselines/mac14-13-apple-m2-max-12c-eng656-traces.json`.
The retired worker does not imply all allocator pages return to the OS; the
post-quiet RSS spread is reported as measured. No production Pi measurement is
claimed; T0 measured the decoder spike on the Pi.

## Build coverage

A minified, split, compiled smoke binary containing the real TraceStore and
worker entrypoint passed ingest → SQLite query → close. The full native Daemon
build was attempted but could not resolve the optional
`@ast-grep/napi-linux-arm64-{gnu,musl}` packages installed for other build targets.
The isolated smoke proves the trace worker's embedded URL and codecs; it does
not replace full release packaging validation.

## TF1 hardening (RT1 F1–F13)

2026-10-31, same Mac14,13 / M2 Max / Bun 1.4.4, source Daemons. Before is
`b2979287` (identical trace implementation to `08798fa8f`). After includes
hardening, synchronous flushes at 1,000 records, and `releaseMemory` on the
worker's actual `close` event; `terminate()` returns before the worker exits.

Commands (same before and after):

```sh
bun run bench idle --quick --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-m31-idle-quick.json
bun run bench traces --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-eng656-traces.json
```

Idle passed. The final trace comparison **failed the post-quiet RSS gate**;
all other trace metrics passed their committed tolerances. A fresh run of the
original implementation also failed that gate and then aborted on HTTP 429.
The baseline remains unchanged. The failure and the discrepancy between native
RSS and physical footprint need investigation in
[ENG-682](https://linear.app/luxdev/issue/ENG-682).

These are busy-workstation observations: before/after background load was 11/8.5
cores for idle and 12/1.9 for the completed trace comparisons. The later original
code recheck started at 3.7 busy cores. CPU and throughput differences cannot be
attributed solely to the patch.

### Idle (medians, three runs)

| Metric | Committed baseline | TF1 before | TF1 after |
| --- | ---: | ---: | ---: |
| Client CPU, % one core | 0.519 | 0.526 | 0.392 |
| Client footprint, MiB | 98.110 | 65.048 | 64.509 |
| Client wakeups/s | 13.098 | 9.498 | 10.098 |
| No-client CPU, % one core | 0.363 | 0.160 | 0.176 |
| No-client footprint, MiB | 97.188 | 64.876 | 64.298 |
| No-client wakeups/s | 10.497 | 6.799 | 7.598 |
| Processes | 1.000 | 1.000 | 1.000 |

No worker or retry timer runs while the receiver is listening and unused. A bind
conflict alone arms backoff. The idle run preceded the final URL redaction,
synchronous flush and close-event corrections; none of those paths runs in an
unused receiver.

### 200k spans (medians, three runs)

| Metric | Committed baseline | TF1 before | TF1 final | TF1 final range |
| --- | ---: | ---: | ---: | ---: |
| Spans/s | 13322.53 | 14429.55 | 20782.55 | 20736.46–20925.26 |
| Ingest ms | 15012.16 | 13860.45 | 9623.46 | 9557.83–9644.85 |
| CPU, % one core | 91.53 | 97.45 | 108.26 | 107.71–109.62 |
| Peak RSS over initial, MiB | 153.06 | 158.92 | 168.14 | 159.06–173.89 |
| RSS after quiet, MiB | 184.84 | 246.78 | 282.72 | 271.61–288.19 |
| Concurrent RPC p99, ms | 16.34 | 26.77 | 2.60 | 2.27–3.97 |

The original-code recheck completed one run: 309.03 MiB RSS after quiet,
196.48 MiB peak RSS delta, 29,843.14 spans/s and 2.31 ms RPC p99. Its second run
aborted with HTTP 429, so these are **not** three-run medians. The final TF1
runs completed every batch; synchronous flushes prevent the zero-delay flush
timer from being starved by continuous worker messages.

An earlier TF1 run passed at 133.17 MiB median post-quiet RSS, but a later run
failed at 286.66 MiB. Moving release to the actual close event still failed at
282.72 MiB. The earlier passing result is retained as intermediate evidence,
not substituted for the final failure.

Temporary instrumentation confirmed worker retirement and memory release. In
one diagnostic run, `process.memoryUsage().rss` fell from 110.2 to 86.5 MiB
across `releaseMemory`; two seconds later the native sampler reported one
Daemon process with 78,513,160 bytes of physical footprint (74.9 MiB), but
303,988,736 bytes of resident size (289.9 MiB). This does not establish which
pages remain resident or invalidate the RSS gate. ENG-682 owns that analysis.
The instrumentation was removed before final checks.

Raw results are under `docs/reviews/2026-10-31-traces-RT1/`: `before-idle.json`,
`after-idle.json`, `before-traces.json`, `before-traces-recheck.json`,
`after-traces.json`, `after-traces-intermediate-pass.json`,
`after-traces-before-close.json` and `retirement-diagnostic.json`.
Initial sandbox runs could not bind sockets/sample processes; all numbers here
come from native runs. No production Pi or full release build was run.

## Forwarding (ENG-674, ENG-675)

2026-10-31, native Mac14,13 / M2 Max / Bun 1.4.4, source Daemon over the bridge.
All runs used the Host's `bench` lease. No committed baseline or threshold changed.
The assigned-base trace run uses a detached worktree at
`c4a1ce26f2a8820181b874b28166ee809b8fba6f`. Dependency directories were symlinked
from P1; the result reports `gitDirty: true`. The driver made no source edits,
but did not capture a porcelain listing before removing the temporary worktree.
The P1 runs use the implementation committed with this record. Each full trace run
sends 200,000 Spans, requires 200 successful responses and checks the final batch
has 1,000 stored Spans. Concurrent RPCs are sampled, followed by 32 seconds of quiet.
That quiet sample allows worker retirement but does not require the forwarding
queue to have drained; pending collector retries can outlast it.

Commands:

```sh
bun run bench traces --runs 1 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-eng656-traces.json
POLARIS_BENCH_TRACE_FORWARDING=down bun run bench traces --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-eng656-traces.json
POLARIS_BENCH_TRACE_FORWARDING=off bun run bench traces --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-eng656-traces.json
bun run bench idle --quick --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-m31-idle-quick.json
```

`down` configures the unavailable collector at `127.0.0.1:1`; an exported collector
that overrides it fails the scenario before ingest. The unconfigured control uses
the same P1 code with no target, so the forwarding queue receives no batches.
P1's queue limit is 32 requests / 8 MiB, including headers and URL accounting.

| Metric | Committed baseline | Assigned base, 1 run | P1 unconfigured, median (range), 3 runs | P1 collector down, median (range), 3 runs |
| --- | ---: | ---: | ---: | ---: |
| Spans/s | 13322.53 | 16836.27 | 16139.85 (14165.87–16433.85) | 16796.65 (15258.14–16925.70) |
| Ingest, ms | 15012.16 | 11879.12 | 12391.69 (12170.00–14118.44) | 11907.13 (11816.35–13107.76) |
| CPU, % one core | 91.53 | 106.20 | 104.45 (98.70–104.84) | 106.60 (102.83–106.91) |
| Peak RSS over initial, MiB | 153.06 | 185.02 | 197.81 (159.73–199.42) | 217.11 (214.80–222.33) |
| RSS after quiet, MiB | 184.84 | 292.69 | 304.83 (235.56–305.17) | 303.31 (254.62–321.84) |
| Concurrent RPC p99, ms | 16.34 | 2.96 | 6.03 (5.89–6.66) | 2.83 (2.49–4.08) |

The assigned base fails the post-quiet RSS gate. Both the P1 unconfigured control and
the outage run fail the peak and post-quiet RSS gates. These are failed comparisons,
not performance passes. The single assigned-base sample alone cannot establish a reliable
regression size. The unconfigured control's peak range also shows substantial
variation. The existing [ENG-682](https://linear.app/luxdev/issue/ENG-682) follow-up
covers reconciliation of native RSS and physical footprint; this work does not
resolve that discrepancy or change the metric.

CPU and throughput comparisons carry the runner's busy-machine warning. Busy cores
at start: committed trace baseline 11.1, assigned base 6.1, P1 unconfigured 3.5, and
P1 outage 3.2. No controlled CPU/throughput improvement is claimed.

### Queue-cap and profile diagnostics

A controlled, temporary edit changed only the default request count from 32 to 8,
leaving the 8 MiB byte cap unchanged. Three outage runs produced peak RSS
199.88 (181.11–210.97) MiB and post-quiet RSS
308.78 (280.23–320.23) MiB. Both RSS gates still failed;
12 busy cores at start limit the comparison. The original 32-request default was
restored after the experiment; no capacity change was adopted from this
uncontrolled comparison.

```sh
POLARIS_BENCH_TRACE_FORWARDING=down bun run bench traces --runs 1 --profile --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-eng656-traces.json
```

The scenario now captures heaps after ingest and after the quiet sample when
profiling is requested. The profiled run reported peak RSS
184.42 MiB and post-quiet RSS
83.00 MiB and passed the comparison. Heap snapshots perturb
collection and memory use, so that result cannot replace the failed unprofiled
runs. The V8-format snapshots reported ArrayBuffer self sizes of 16,030,236 bytes
after ingest and 15,159,501 after quiet across the process; these are not a
measurement of the forwarding queue alone and do not explain native RSS.
`heap-summary.json` contains aggregate counts, without heap contents. CPU profiles
and heaps remain in the ignored local result directory
`2026-10-31T22-07-42-359Z/traces-run1`; they are not shipped as fixtures.

### Idle

The pre-integration and final three-run idle comparisons both pass their gates.
The initial run was recorded on the dirty P1 worktree before receiver/runtime
integration. Both use the existing 10-second quick windows after a settle.

| Metric | Committed baseline | Pre-integration median, 3 runs | P1 final median (range), 3 runs |
| --- | ---: | ---: | ---: |
| Client CPU, % one core | 0.52 | 0.58 | 0.58 (0.49–0.72) |
| Client footprint, MiB | 98.11 | 64.83 | 65.58 (64.70–65.79) |
| Client wakeups/s | 13.10 | 9.60 | 10.20 (10.10–10.40) |
| No-client CPU, % one core | 0.36 | 0.19 | 0.25 (0.23–0.29) |
| No-client RSS, MiB | 133.41 | 100.80 | 109.61 (107.56–109.64) |
| No-client footprint, MiB | 97.19 | 64.56 | 64.88 (64.49–65.42) |
| No-client wakeups/s | 10.50 | 6.90 | 7.40 (7.40–7.40) |
| Processes | 1.00 | 1.00 | 1.00 (1.00–1.00) |

Client maximum CPU was 6.05% versus the baseline's 1.33%, an informational,
non-gating result. Idle background load was 4.4 busy cores in the baseline, 12 in
the initial run and 4.2 in the final run; CPU comparisons carry the same warning.
An unused forwarding queue adds no timer.

Raw results are under
[`packages/bench/measurements/eng-674`](../../../../packages/bench/measurements/eng-674).
They are evidence, not new baselines. The earlier trace run interrupted during
Host resource exhaustion and the retry that found port 4319 occupied produced no
usable before/after comparison and are excluded. No production Pi or hosted
collector measurement is claimed.
