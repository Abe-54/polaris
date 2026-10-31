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
