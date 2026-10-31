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

## Turn comparison (ENG-660)

2026-10-31, same Mac14,13 / M2 Max / Bun 1.4.4, one full run per side,
sequentially under the Host's `bench` lease. Before is an isolated `git archive`
of assigned base `c4a1ce26f2a8820181b874b28166ee809b8fba6f`; workspace dependency
links resolve into that archive. After contains P8's compare implementation.
Both run the existing 200k-Span receiver/SQLite/concurrent-RPC scenario and its
32-second quiet window. This checks the shared ingest path, not compare-query
latency. Compare adds only an on-demand worker request and no idle timer.

Command on each source tree:

```sh
bun packages/bench/src/cli.ts traces --runs 1 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-eng656-traces.json
```

| Metric | Committed baseline | Assigned base | P8 |
| --- | ---: | ---: | ---: |
| Spans/s | 13,323 | 17,543 | 17,249 |
| Ingest, ms | 15,012 | 11,400 | 11,595 |
| CPU, % one core | 91.53 | 106.2 | 107.2 |
| Peak RSS over initial, MiB | 153.1 | 202.7 | 184.5 |
| RSS after quiet, MiB | 184.8 | 309.8 | 292.9 |
| Concurrent RPC p99, ms | 16.34 | 3.78 | 3.00 |

Both comparisons exit 1: the assigned base fails peak and post-quiet RSS gates;
P8 fails the post-quiet gate. This reproduces the existing ENG-682 limitation on
the unchanged base; the committed baseline is unchanged. These single runs do
not establish a statistically reliable improvement or regression from P8.
Background load was 2.8/2.4 busy cores; the committed baseline had 11.1, so its
CPU and throughput comparison carries the runner's warning. The recorded
one-minute load averages at benchmark start were 6.18 and 4.03.

Logs and raw results from this run are `/private/tmp/p8-leased-bench-base.log`,
`/private/tmp/p8-leased-bench-after.log`, `/private/tmp/p8-leased-base-bench.json`
and `/private/tmp/p8-leased-after-bench.json`. An earlier quick run had different
sizes and 11.9 busy cores and cannot serve as a before/after comparison. An
initial full archived-base attempt failed because port 4319 was occupied and
produced no metrics. No production Pi or compare-query latency measurement is
claimed.
