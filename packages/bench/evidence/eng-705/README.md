# ENG-705: optional Daemon services at first use

B1 starts at `52e6ed01a1ac312756775ef0de3e32f63abbc1b8` (0.8.0). The approved CI refresh changes only the 15 metric values listed below; all tolerances and other metrics remain unchanged.

Data implementations now load on a Client/MCP request, an outside-command record, or a Turn in a migration checkout. Existing `data.sqlite` still activates startup recovery before serving requests. Traces keeps its fixed receiver port at startup; its implementation loads on the first receiver request or service use. Profiles loads independently when requested. Terminals outside registered Workspaces resolve authority without initializing the trace runtime or store. Capability advertisement is unchanged. Service interfaces remain eagerly available to Engine, Harnesses and MCP; implementation layers retain the Daemon scope and share one cached build.

The older Mobile/Relay startup path also imported push encryption and the Noise/libsodium stack while the Relay route was off. Those imports now happen when validating a push key, sealing a push, loading relay keys or starting the relay. Link proof validation uses the same cryptographic functions captured when the offer is created.

## Local measurements

Commands ran through `bun apps/daemon/src/main.ts lease bench -- …` on Mac14,13 / Apple M2 Max, Bun 1.4.4. `before.json` is the clean assigned base; `after.json` is the implementation before commit. The original pair uses `cold-start idle --quick --runs 3`; the final after run also includes `terminal`.

| Metric (median) | Before | After |
| --- | ---: | ---: |
| Startup modules | 847.000 | 706.000 |
| Polaris startup modules | 496.000 | 411.000 |
| Cold settled RSS, MiB | 103.906 | 98.688 |
| Cold settled footprint, MiB | 63.423 | 59.314 |
| Idle with Client RSS, MiB | 108.047 | 106.500 |
| Idle without Client RSS, MiB | 85.391 | 106.500 |
| Idle with Client footprint, MiB | 64.860 | 63.016 |
| Idle without Client footprint, MiB | 68.188 | 62.641 |

The module reduction is deterministic across all three runs. The RSS comparison is not a clean idle-memory improvement: the before run's no-Client RSS ranged from 85.328 to 108.109 MiB, and the after run from 104.516 to 108.312 MiB. Background load was 7.1 cores before and 3.1 after. Do not treat timing or CPU differences as a performance claim.

## Pre-existing CI regression history

The committed CI baseline identifies `0cec7835ed78` and uses 603 startup modules (the count was subsequently accepted for extension subsystems). The following are original CI results, not local measurements:

| Head | Run / benchmark job | Modules | Idle Client RSS, MiB | Terminal peak over base, MiB |
| --- | --- | ---: | ---: | ---: |
| `1127b4cb` (0.3.3) | [40702023027 / 122864066594](https://github.com/luxdotdev/polaris/actions/runs/40702023027/job/122864066594) | 603 | 83.29 | 22.50 |
| `e978561c` (0.4.0) | [40711183646 / 122897699327](https://github.com/luxdotdev/polaris/actions/runs/40711183646/job/122897699327) | 691 | 89.96 | 22.62 |
| `35396f3f` (0.5.0) | [40818576927 / 123265399286](https://github.com/luxdotdev/polaris/actions/runs/40818576927/job/123265399286) | 697 | 89.94 | 21.35 |
| `1b095920` (0.7.0) | [41087817701 / 124175282854](https://github.com/luxdotdev/polaris/actions/runs/41087817701/job/124175282854) | 746 | 92.15 | 22.27 |
| `ae37cd2d` | [41142389711 / 124360271711](https://github.com/luxdotdev/polaris/actions/runs/41142389711/job/124360271711) | 746 | 91.94 | 19.82 |
| `490e8ad2` | [41236878221 / 124642401731](https://github.com/luxdotdev/polaris/actions/runs/41236878221/job/124642401731) | 747 | 91.58 | 32.40 |
| `09fc8712` | [41242462324 / 124658981895](https://github.com/luxdotdev/polaris/actions/runs/41242462324/job/124658981895) | 747 | 91.96 | 34.46 |
| `52e6ed01` (0.8.0) | [41278289751 / 124764836768](https://github.com/luxdotdev/polaris/actions/runs/41278289751/job/124764836768) | 847 | 96.72 | 34.91 |

The first large import/steady-memory step spans Mobile/Relay merge `e19ae20b2e744191e632d3b066f83a23b73e9594`. The current change defers its optional crypto imports as well as the 0.8.0 Data/Traces implementations.

The terminal step instead coincides with the runner moving from Ubuntu 24.04.5 to Ubuntu 26.04.1 between `ae37cd2d` and `490e8ad2`. Terminal, Client terminal, benchmark terminal and sampler code did not change in that interval. The [unchanged `ae37cd2d` rerun, job 124776869058](https://github.com/luxdotdev/polaris/actions/runs/41142389711/job/124776869058), ran on Ubuntu 26.04.1 and measured 34.78 MiB terminal peak delta, versus its original 19.82 MiB on Ubuntu 24.04.5. That reproduces the terminal failure without a product-code change and supports runner-image drift. Any baseline change still requires approval.

Adjacent source snapshots of `e19ae20b^` and `e19ae20b` were also measured locally (`pre-mobile.json`, `mobile.json`; `cold-start idle terminal --quick --runs 1`). Every tracked file was hash-checked against the corresponding Git tree. The merge changed modules 603→691, settled RSS 88.891→93.875 MiB, idle Client RSS 95.789→100.742 MiB. Terminal peak delta was 32.250→29.953 MiB, consistent with the terminal regression being later. These single runs had 7.5/4.5 busy cores and are diagnostic evidence, not a replacement baseline.

## Regression checks

The six isolated first-use tests pass. Negative controls independently restored eager Data/Traces composition, restored eager Relay crypto, removed existing-storage startup recovery, removed terminal Workspace preflight, and removed migration activation. Each control failed its named test; every file was restored before the passing run. These tests cover unloaded startup implementations, concurrent shared Data service/RPC state, receiver first request after restart and token revocation, migration activation, durable unfinished-write recovery before the first request, and avoiding Traces initialization for unregistered terminals.

The terminal first-use path was also measured three times against an unmodified source snapshot of assigned base `52e6ed01` (`terminal-before.json`), immediately before the final after run under the same lease. Median peak RSS over base: 38.281→35.891 MiB. The terminal checkout is unregistered, so it should not activate Traces.

## Approved CI median refresh

The user chose three-run medians, and the Lead reviewed and approved these exact values before commit. The samples come from PR #14, run [41286847452](https://github.com/luxdotdev/polaris/actions/runs/41286847452), attempts 1, 2 and 3, all at merge head `41ef221e6fbc`. Each used Ubuntu 26.04.1, Bun 1.4.4, an AMD EPYC 7763 and four cores. Background load was 0.1, 0.2 and 0 cores.

| Attempt | Job | Artifact ID | Evidence |
| --- | --- | --- | --- |
| 1 | [124789772574](https://github.com/luxdotdev/polaris/actions/runs/41286847452/job/124789772574) | 13075177817 | [ci-attempt-1.json](ci-attempt-1.json) |
| 2 | [124812087770](https://github.com/luxdotdev/polaris/actions/runs/41286847452/job/124812087770) | 13079120960 | [ci-attempt-2.json](ci-attempt-2.json) |
| 3 | [124812888985](https://github.com/luxdotdev/polaris/actions/runs/41286847452/job/124812888985) | 13078334136 | [ci-attempt-3.json](ci-attempt-3.json) |

Artifact IDs and timestamps were checked against the job logs. A download by name initially returned attempt 2 twice; attempt 3 was downloaded by its exact artifact ID before computing these medians.

Only the following baseline `value` fields change. Units are MiB except startup modules. Historical baseline metadata and other per-metric fields remain unchanged; these artifacts record the provenance of the selective refresh.

| Gate | Old baseline | Attempt 1 | Attempt 2 | Attempt 3 | New median |
| --- | ---: | ---: | ---: | ---: | ---: |
| cold-start.footprint_settled_mib | 40.09765625 | 46.08984375 | 46.04296875 | 46.16796875 | 46.08984375 |
| cold-start.startup_modules | 603 | 703 | 703 | 703 | 703 |
| idle.client_rss_mib | 80.6953125 | 90.23828125 | 90.294921875 | 89.9375 | 90.23828125 |
| idle.client_footprint_mib | 43.30078125 | 51.16015625 | 51.212890625 | 50.859375 | 51.16015625 |
| idle.noclient_rss_mib | 80.755859375 | 90.36328125 | 90.41796875 | 89.9921875 | 90.36328125 |
| idle.noclient_footprint_mib | 43.328125 | 51.22265625 | 51.2734375 | 50.8515625 | 51.22265625 |
| sessions.rss_before_mib | 86.4921875 | 99.70703125 | 100.234375 | 99.59765625 | 99.70703125 |
| sessions.m5.footprint_peak_mib | 71.0390625 | 90.83984375 | 85.51953125 | 87.7890625 | 87.7890625 |
| sessions.m10c3.footprint_peak_mib | 92.23828125 | 115.40625 | 109.6484375 | 115.52734375 | 115.40625 |
| history.seed_footprint_peak_mib | 107.671875 | 135.8828125 | 141.07421875 | 137.1640625 | 137.1640625 |
| history.loaded_rss_mib | 80.90234375 | 90.640625 | 90.66796875 | 91.125 | 90.66796875 |
| history.loaded_footprint_mib | 43.6015625 | 51.68359375 | 51.6953125 | 52.16796875 | 51.6953125 |
| editor.tabs20_daemon_rss_mib | 81.6328125 | 90.84765625 | 87.73046875 | 108.5625 | 90.84765625 |
| editor.tabs20_daemon_footprint_mib | 43.18359375 | 51.58203125 | 48.4609375 | 69.35546875 | 51.58203125 |
| terminal.rss_peak_over_base_mib | 22.01953125 | 33.6328125 | 33.94921875 | 33.44140625 | 33.6328125 |

The refresh accepts residual core service and protocol growth since the 603-module baseline after deferring optional implementations: Linux startup is now 703 modules, down from 847 on 0.8.0. Cold RSS fell from 93.22 MiB on 0.8.0 to 84.54 MiB in attempt 1 and already passes the unchanged cold-RSS gate. Existing session/history peaks mostly improve over 0.8.0; this refresh does not claim all historical core growth has been eliminated. The terminal refresh is also supported by the unchanged-commit Ubuntu runner-image reproduction above. No tolerance is widened.

### Variance limits and ENG-706

Spread means maximum minus minimum across the three samples. The comparison allowance is `max(relative × old baseline, absolute)`, matching the gate calculation. These five gated metrics have spreads exceeding their existing allowance:

| Gate | Attempt 1 | Attempt 2 | Attempt 3 | Spread | Existing allowance |
| --- | ---: | ---: | ---: | ---: | ---: |
| blobs.upload_footprint_peak_over_base_mib | 21.28125 | 23.375 | 32.3515625 | 11.0703125 | 9.515625 |
| blobs.footprint_retained_mib | 5.9296875 | 3.4453125 | 12.6484375 | 9.203125 | 4 |
| blobs.rss_retained_mib | 6.9296875 | 4.4453125 | 13.5234375 | 9.078125 | 4 |
| editor.tabs20_daemon_rss_mib | 90.84765625 | 87.73046875 | 108.5625 | 20.83203125 | 8.16328125 |
| editor.tabs20_daemon_footprint_mib | 51.58203125 | 48.4609375 | 69.35546875 | 20.89453125 | 5 |

The editor spreads also exceed the allowances at the approved medians (RSS 9.084765625 MiB; footprint 5.158203125 MiB). Attempt 3 would still fail both editor gates against the new medians. The three blob baselines are outside this approval and remain unchanged. [ENG-706](https://linear.app/luxdev/issue/ENG-706) tracks editor tabs20 and blob variance; no variance investigation or additional baseline changes are included here.

All other comparable gated spreads fit the existing allowances. The git footprint peak has samples 76.2734375, 75.57421875 and missing, so it has no three-run spread; no value was invented for the missing sample. All 15 refreshed gates have three samples. A fresh CI run after this commit will determine the current benchmark result; the medians do not guarantee a green run.
