# P3 integration evidence — ENG-657

The helper checkpoint is `f6bb6fb93800e5ea4c6f675177e5ff8bdbe321dc`.
Merge `318ae375987d` integrates the Lead's exact accepted head
`9a0fac480958ce46e47a478c2c3cb3a412ebae9f`. The build conflict retains
P4's Profile worker entrypoint together with P3's instrumentation build plugin.
`CHECKPOINT.md` records historical checks; this report describes the final
runtime/settings composition and its fresh checks.

## Behavior

- Explicit Workspace Node mode prepends the bundled preload to existing
  `NODE_OPTIONS`. The new shared `../nodeOptions.ts` helper exports
  `appendNodeImport(options, path)` for P9; it quotes paths and avoids duplicate
  absolute-path/file-URL imports, including `--import=value`.
- An SDK dependency in the launch package or an ancestor manifest suppresses
  instrumentation unless the manual override is set. Unreadable manifests also
  skip by default. The nearest package supplies the service name. Deno mode sets
  `OTEL_DENO=true`. The preload refuses to install a provider inside Bun, and no
  `BUN_OPTIONS` are changed.
- The captured runtime services preserve authority even when a managed Hook
  invokes the environment function without a caller service context. Workspace
  Trust and writable Agent Session policy remain mandatory; overrides cannot
  bypass them. The local-copy switch and forwarding switch remain independent
  of the explicitly requested instrumentation mode.
- P1 collector preparation and all three injected endpoint variables are
  preserved. P2's optional launch Turn and signed child authentication remain
  intact. Terminal and Profile children retain the complete overlay.
- Fixed-exporter evidence is read-triggered after observed application work,
  with an OTel dependency and no stored spans. It contains checkout-relative
  file/line only. It clears when spans arrive or launch evidence is unavailable.
  There is no scanner timer, watcher or idle polling. Discovery and evidence
  caches are bounded; README.md documents the limits and conservative matches.

## Final-source validation

All receipts are **Reported**. These shell commands have no Daemon command-item
references. Heavy commands run sequentially inside the Host's `bench` lease;
compiler concurrency is bounded with `GOMAXPROCS=2`. No timeout was loosened.

| Check | Outcome | Local log |
| --- | --- | --- |
| Root `bun run typecheck` | 18/18 tasks pass, 17 cached | `/private/tmp/p3-final-typecheck.log` |
| Full Daemon tests | 3,321 pass, 87 skip, 0 fail; 104,556 assertions, 584 files | `/private/tmp/p3-final-daemon-tests.log` |
| Root `bun run test` | 19/19 tasks pass, 17 cached; Daemon repeats 3,321 pass / 87 skip / 0 fail | `/private/tmp/p3-root-test.log` |
| Root `bun run lint` | Format check and lint ratchet pass, 5,692 files | `/private/tmp/p3-final-lint.log` |
| `bun run licenses:check` | 1,278 production dependencies plus 132 platform builds, zero violations | `/private/tmp/p3-final-licenses.log` |
| Host build and native selftest | fff, rules/betterleaks and libsodium pass | `/private/tmp/p3-final-build.log` |
| Actual relocated binary smoke | Two HTTP/fetch spans, `service.name=packaged-node-app`, extracted preload | `/private/tmp/p3-final-packaged.log` |

The full Daemon run includes the real terminal Node and Bun children, the SDK
skip/override and Deno environment checks, captured-service/forwarding-only
regression, fixed-exporter discovery and stale-evidence clearing, shared import
composition, correlated log export and endpoint-down success. The fetch test
satisfies the real outbound-call requirement; it is not a real database test.

### Actual compiled binary

Build with `bun scripts/build-daemon.ts darwin-arm64`, then run:

```sh
bun apps/daemon/src/main.ts lease bench -- bun apps/daemon/src/traces/instrumentation/packaged.smoke.ts apps/daemon/dist/darwin-arm64/polaris
```

The smoke copies the real compiled executable into a fresh directory and starts
it from there with a private Daemon home. Through real local RPC it registers a
scratch Workspace, seeds only that disposable Workspace's Trust fixture, opts in
to Node instrumentation and opens a terminal running Node's HTTP server and
fetch. It checks the stored server/undici spans, package service name and preload
path extracted under that private home. It stops the Daemon and removes the
scratch files. No installed Daemon or live Workspace Trust is changed.
Native Node was `v24.22.1`, Bun `1.4.4`, macOS arm64. The first final-source build
reported `0.7.0-dev.3075.318ae37.dirty1793492364`; it includes the uncommitted
integration source tested above, rather than claiming that source existed in
the merge commit itself.

## Performance

The three-run quick idle comparison passes every gate against the committed
`mac14-13-apple-m2-max-12c-quick.json` baseline. The baseline is unchanged.
Raw historical pre-composition and final-source results are in `evidence/`.

| Idle metric | Committed baseline | Final source |
| --- | ---: | ---: |
| Client RSS, MiB | 110.00 | 109.08 |
| Client physical footprint, MiB | 77.02 | 66.00 |
| No-client RSS, MiB | 110.09 | 109.11 |
| No-client physical footprint, MiB | 76.33 | 65.67 |
| Client wakeups/s | 13.40 | 10.40 |
| No-client wakeups/s | 10.90 | 7.60 |

The baseline began with 2.7 cores busy, the final run with 4.8, and the historical
pre-composition run with 8.2. CPU and throughput are not quiet-Host measurements.
The pre-composition run predates the accepted peer integrations and is not a
matched causal comparison of P3 alone.

An additional terminal benchmark passes throughput but fails the historical
memory gates: RSS over base 36.31 MiB versus 21.00; physical footprint over base
33.22 MiB versus 12.49. A disposable checkout of exact accepted integration head
`9a0fac480958ce46e47a478c2c3cb3a412ebae9f` reproduces both failures: 34.92 MiB RSS
and 33.39 MiB physical-footprint deltas. The immediately following P3 run passes
all gates against that accepted-base result: 36.05 MiB RSS (+3.2%), 30.89 MiB
physical footprint (-7.5%), stream time 680.0 versus 664.2 ms (+2.4%).

These three-run quick comparisons ran consecutively under one Host lease with
the same installed dependencies. The accepted base began with 3.4 busy cores,
P3 with 4.0; they are not quiet-Host CPU/throughput measurements. Raw results are
retained in `evidence/terminal-accepted.json` and `terminal-matched.json`. The
temporary checkout was removed successfully. The inherited historical gate
failure remains open as [ENG-695](https://linear.app/luxdev/issue/ENG-695), linked
to ENG-657 on Polaris 0.8.0. No baseline is rewritten to conceal this failure.

## Ownership and limits

`transport/serve.ts` is the sole new source path outside the assigned Area. It
shares the existing Workspace Trust layer with TraceRuntime, so the production
runtime can enforce Trust rather than treating an absent service as authority.
The narrow runtime/settings composition was explicitly assigned to P3 after P1
acceptance. P4's `profiles/index.ts` receives one optional post-spawn evidence
call; its process ownership, restart identity, Turn attribution and profiling
options remain unchanged. P9's unaccepted source is not absorbed.

No event-store command semantics, Engine decisions, lifecycle machine or wire
contract change. No model-spec or performance baseline change. Dependencies are
pinned exactly and the generated notices preserve upstream licence text. No
upstream source was copied into tracked source, so ATTRIBUTION.md needs no new
entry. No hooks are bypassed; no push, installation or upgrade is performed.

The 87 existing platform/live-service skips remain skips. Deno environment
composition is verified; no native Deno application, Pi, Windows release or live
Postgres/MySQL workload is claimed. Static detection does not evaluate aliases,
computed configuration or ignored/generated files. Interactive shell descendants
without recorded commands are not inferred. Explicit exit or forced termination
can lose buffered telemetry. Existing ENG-682 trace RSS limitations are not
resolved by this instrumentation work.
