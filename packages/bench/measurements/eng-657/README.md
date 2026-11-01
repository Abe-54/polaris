# ENG-657 preload and launch measurements

Historical P3 measurements are `idle-before.json`, `idle-final.json` and the
three `terminal-*.json` files. Their provenance and limits are in the
[P3 review report](../../../../docs/reviews/2026-10-31-traces-P3.md).
P2's launch-attribution report and four raw runs are under [launch](./launch/README.md).
P1's forwarding report is [ENG-674/BENCH.md](../eng-674/BENCH.md).

## UF11 pre-integration checks

`uf11-startup.json` and `uf11-idle-terminal.json` were measured on the dirty
UF11 tree based on `66bc0aecfd601ad6f0fbdd54355d29b11c99d3b7`, before merging
P9. The startup run has private providers, shared async context and W3C trace
propagation; W3C baggage propagation was added afterwards. These are observations,
not replacements for the committed machine baseline.

Native Node 24.22.1, Bun 1.4.4, macOS arm64, Apple M2 Max. The startup script
interleaves the three cases, discards five warmups per case, and records 25
samples of `node -e 0` per case. The samples include process creation and exit.
The endpoint case points at a refused loopback port; no application spans are
created. Export throughput is not measured by this startup probe.

| Case | Median, ms | Difference from plain, ms |
| --- | ---: | ---: |
| Plain | 33.986 | 0 |
| Preload, no endpoint | 34.641 | 0.655 |
| Preload and endpoint | 83.900 | 49.914 |

`sdk.cjs` was 384,112 bytes. The register loads neither SDK nor ESM hook without
`POLARIS_OTEL_ENDPOINT`. The three-run quick Daemon benchmark passed all idle
gates and failed the two historical terminal memory gates: RSS growth 35.28 MiB
against 21.00 MiB; footprint growth 30.78 MiB against 12.49 MiB. The runner
reported 12 busy background cores versus 2.7 in the baseline. CPU and throughput
are not quiet-Host comparisons. The baseline is unchanged;
[ENG-695](https://linear.app/luxdev/issue/ENG-695) tracks those terminal gates.

Run startup measurements from the repository root:

```sh
bun apps/daemon/src/main.ts lease bench -- bun apps/daemon/src/traces/instrumentation/startup.bench.ts packages/bench/measurements/eng-657/new-startup.json
```

The broad root suite on this pre-integration checkpoint passed 18 of 19 package
tasks. The Daemon reported 3,373 pass, 92 skip and three failures across 591
files: the [ENG-683](https://linear.app/luxdev/issue/ENG-683) push sent-outcome
assertion, the 30-second extensions connection model timeout and the 5-second
Constellation model timeout. This is a failed full-suite run. The final scoped
checks and isolated failure rechecks are recorded separately below.

## UF11 final preload and integration

UF11 merged P9's accepted integration `da8530c5` at `1772b908`, then retained
`OTEL_BSP_SCHEDULE_DELAY` in `6df0f481`. It subsequently merged SEC1's accepted
`7140186fa` integration, retaining both compile autoload flags as `false`.
No P9 source change was needed; `appendNodeImport(options, path)` is unchanged.
UF13 consumes the added `stripNodeInstrumentation(options: string): string`.

`uf11-final-startup.json` measures the final preload source, including shared
async context, W3C trace-context/baggage propagation and the batch-delay fix.
The run preceded SEC1's merge; SEC1 changes no preload asset. The earlier
`uf11-integrated-startup.json` predates the batch-delay fix and is retained as
intermediate evidence.

| Final preload case | Median, ms | Difference from plain, ms |
| --- | ---: | ---: |
| Plain | 29.830 | 0 |
| Preload, no endpoint | 30.399 | 0.569 |
| Preload and endpoint | 74.988 | 45.158 |

The no-endpoint overhead is below the 15 ms target. The final SDK bundle is
384,271 bytes; it imports the trace-only `sdk-trace@3.0.0` package and HTTP
exporters, without NodeSDK's gRPC, Prometheus or Zipkin exporters. OTel 3 calls
this package `sdk-trace`; `sdk-trace-node@3.0.0` does not exist. Startup timing
uses the same 25-sample, five-warmup interleaved procedure described above.

### Daemon benchmark control

`uf11-integrated-idle-terminal.json` records the three-run quick comparison after
P9's merge. All idle gates pass. The terminal memory gates still fail the
unchanged historical baseline. `uf11-accepted-terminal.json` is a consecutive
three-run control from a disposable `git archive da8530c5` source tree sharing
only the pinned dependency installations. Its `gitSha` is empty because the
archive has no `.git`; the control source was exactly the accepted integration.
The temporary source tree was removed after the run; its measurement stays here.

| Terminal median | Historical baseline | Accepted da8530c5 | UF11 integrated |
| --- | ---: | ---: | ---: |
| RSS growth, MiB | 21.00 | 34.56 | 34.13 |
| Footprint growth, MiB | 12.49 | 32.20 | 27.70 |
| Stream time, ms | 593.3 | 642.7 | 643.2 |

Both comparisons exit 1 for the same two historical memory gates. These results
do not establish a new UF11 memory regression or turn those gates green.
The UF11 run reported 3.1 busy background cores and the control 4.2, versus 2.7
in the baseline; CPU and throughput are not quiet-Host measurements. The
batch-delay follow-up only changes a child SDK setting; these default-off
Daemon scenarios do not initialize that SDK. SEC1's later forwarding changes
are not represented by this matched comparison. ENG-695 remains open.

### Regression evidence

- The five RP1 repros now live in `instrumentation/preload.test.ts`; the review
  copies are deleted. Temporarily restoring the six original preload modules
  from `66bc0aec` makes all five fail (0 pass, 5 fail). The fixes were restored.
- A real HTTP server and its outgoing fetch share one trace and the expected
  parent ID. Removing shared async context makes that assertion fail.
- A late app NodeSDK exports its manual request span and logs to its own vendor;
  the manual span retains the Polaris server's trace and parent span IDs.
  Substituting the original bundled NodeSDK implementation makes the vendor
  span disappear and this test fail. The mutation changes only the test bundle.
- The long-lived-child batch-delay test receives no spans before its deadline
  without the fix, and passes with it. P9's unchanged composition check dropped
  from 5.29 seconds to 348 ms in the focused recheck; these individual test
  durations are diagnostic, not benchmark medians.
- Additional native tests cover child cwd/entry ownership, known wrappers,
  duplicate direct register/SDK imports, deleted assets in inherited shells,
  next-launch recreation, partial-file repair, three-build pruning, no-endpoint
  lazy loading and missing build-plugin execution.

The initial full-suite failure remains a failed run, even though its three
failed files pass isolated rechecks at their original timeouts: 9 pass, 0 fail,
32,184 assertions in 13.08 seconds. ENG-683 tracks the push assertion;
[ENG-699](https://linear.app/luxdev/issue/ENG-699) tracks the two full-suite model
timeouts. No timeout, baseline or model-coverage setting was relaxed.

The first post-SEC1 scoped run had 430 pass, 8 skip and one failure: the
accepted P9 attach test completed its capture but timed out waiting for the
inspector URL to clear. Its isolated recheck passed 13 tests and 54 assertions
in 4.50 seconds without changes. [ENG-701](https://linear.app/luxdev/issue/ENG-701)
tracks this intermittent cleanup failure; UF14 owns the attach replacement.
That peer work is not part of UF11's tested head. The generated final-startup
JSON initially failed format checking and was formatted before the final lint.

The final post-SEC1 scoped rerun passed 431 tests with 8 skips and no failures
(2,775 assertions across 67 files, 181.49 seconds). Root typecheck and
licenses:check passed on the same source. The final root lint passed after
formatting the generated startup JSON. No test timeout was changed.

All check receipts are Reported, not Daemon command-item Verified receipts.
The initial darwin build failed because optional Linux ast-grep packages were
absent; `bun install --frozen-lockfile --os='*' --cpu='*'` restored them. The
subsequent fresh build at `1772b908` passed native selftest, and the relocated
packaged smoke reported two spans, `service.name=packaged-node-app`, and
`extractedFromBinary=true` on Node 24.22.1. The smoke procedure is in the
[instrumentation README](../../../../apps/daemon/src/traces/instrumentation/README.md#packaged-smoke).

No Linux/Windows build or native Deno workload is claimed. Existing real
Postgres/MySQL, default-shell and large-trace performance skips remain skips.
The three-build policy does not track live references: new fail-soft shells
survive pruning but need a new launch to resume automatic telemetry. Legacy
shells with raw file imports must be reopened to receive that protection.
