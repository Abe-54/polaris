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
