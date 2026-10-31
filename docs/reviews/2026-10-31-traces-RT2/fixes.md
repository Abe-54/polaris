# TF2: RT2 fixes (ENG-656)

Implementation starts at `c4a1ce26f2a8820181b874b28166ee809b8fba6f`, including accepted TF1's
registered-Workspace HTTP fixture. This report is a correctness checkpoint; the controlled
performance window and final Claim are still pending.

## Findings

| Finding | Change | Regression |
| --- | --- | --- |
| F1 | Choose groups by retention priority, then render the chosen set in depth-first start order. Compute indentation from the final retained ancestry. | Original parent-reading assertion in `traceFormat.rt2.test.ts`. |
| F2 | Reserve the error and exception before its ancestors. Compress paths longer than 12 nodes to the root and five nearest ancestors; cap visual indentation at 20 and print actual depth/parent for compressed paths. | Original depth-149 failure assertion. |
| F3 | Clip list cells to 200 characters with explicit counts before applying the response cap. | Original huge-error row test; existing huge-root test now requires both traces to remain visible. |
| F4 | Build the view inside the SQLite worker. Return one full representative Span per displayed group plus all member ids, instead of transferring and decoding tens of thousands of full Spans on the Daemon thread. | Original 50k-Span latency and event-loop-stall assertions, opt-in performance run. |
| F5 | Collapse error siblings by name/status/exception type/message, retaining ERROR and one exception sample. Preserve every member id in structured groups. | Original 300-retry test plus representative/member assertions. |
| F6 | Persist name, parent name, trace start and duration; index by checkout/name/parent/trace start/Span start. Select at most 50 earlier observations per pair before ranking. History reads compact id/name metadata and never calls `getTrace`. Existing stores migrate transactionally. | Original 5k test, new 105,105-Span <500 ms/<100 ms test, plus bounded-sample, late/changed/removed-parent and migration tests. |
| F7 | A worker list request retrieves one indexed error Span per listed trace, never a full trace. Root history is capped to 50 earlier traces. | Original 20-error-trace timing assertion. |
| F8 | Return the summary start with the single-Span worker read; the tool no longer calls `get`. | Original single-Span timing assertion. |
| F9 | Not a bug on the assigned base: offsets already use the earliest trace start, including clock skew. The original repro passed before changes and remains a regression. | Original nonnegative-offset assertion. |
| F10 | Compare each group's p50 against its usual duration. | Original first-member-outlier assertion. |
| F11 | Order exceptions and logs before attributes, clip individual lines and budget sections separately. Keep full structured detail. | Original long-SQL/exception/stack assertion and existing full-detail test. |
| F12 | Span prefixes are unique against every retained Span, including folded ones. Lists print full trace ids, including when a colliding trace is outside the page. | Original prefix retrieval assertion plus cross-page trace-id test. |
| F13 | E-INPUT identifies lowercase hexadecimal syntax and both id length ranges. | Original actionable-fix assertion. |
| F14 | Convert lone surrogates to U+FFFD and replace bidi overrides/isolates in both text and structured strings. Storage is unchanged. | All three tools tested with adversarial names/attributes; no live Codex parser claim. |
| F15 | An error-free errors-focus response says `No error spans; use focus slow.` | Explicit empty-focus regression. |

## Contract and integration

`docs/specs/traces-tools-v1.md` records the text and structured changes. `trace` now returns
`{summary, spans, groups: [{spanIds}], folded}`: `spans` and `groups` are aligned, with one full
representative and every retrievable member id per displayed group. Folded counts still count
Spans in undisplayed groups, not undisclosed member details. The trace tools remain read-only and
checkout authority still comes from the calling Agent Session.

The public `TraceStore.history(checkout, traceId, includeSpans?)` signature and
`{root, spans, samples}` result are unchanged for T4F and P8. Desktop RPC/protocol shapes are
unchanged. History samples now mean the most recent (at most 50) earlier retained observations
per name/parent-name pair. At least five are required. Root history uses at most 50 earlier
retained traces. Equal/future trace starts and other checkouts are excluded.

The critical-path test previously asserted priority as display order. It now forces a cap with
repeated groups whose aggregate exceeds the longest individual child, and requires the critical
leaf to survive. This tests selection while F1 tests correct tree display.

## Evidence so far

Before changing storage on the assigned base (Bun 1.4.4, Mac14,13/M2 Max):

| Repro | Before |
| --- | --- |
| F4: trace with 50k Spans | 1,917 ms; main-thread stall 386 ms |
| F6: history with 5k stored Spans | 2,106 ms; concurrent list 1,104 ms |
| F7: list 20 error traces of 5k Spans | 4,074 ms |
| F8: one Span in a 50k-Span trace | 1,243 ms; direct store read 28 ms |

These initial repro measurements did not capture load average. The three-run before benchmark
passed every committed gate: 16,489 Spans/s, 12,129 ms ingest, 106.8% CPU, 184.8 MiB peak RSS over
base, 168.4 MiB RSS after quiet, 5.90 ms concurrent RPC p99. It recorded 6.5 busy background cores;
the committed baseline recorded 11.1. Raw result is retained in the worktree's ignored benchmark
results, `2026-10-31T20-18-11-232Z/result.json`, and `/private/tmp/tf2/bench-before-native.log`.

An interim after run under load did not meet all timing gates: F4 6,778 ms/stall 35 ms;
F6 5k 1,036 ms/list 30 ms; F7 1,220 ms; F8 145 ms/direct 776 ms. Load samples around that run
were 40.75 and 60.73; these are surrounding observations, not per-measurement load averages.
Functional checks later hit Bun's default five-second timeout as Host memory pressure increased.
The operator reported load 210 and exhausted memory/swap; a later local sample was
347.75/216.50/149.72. No timeout or performance assertion was loosened.

All subsequent broad checks use `bun apps/daemon/src/main.ts lease bench -- <command>` and run
sequentially. Functional checks and final performance receipts are recorded below as they complete.
Performance tests require `POLARIS_TRACE_PERF=1`; ordinary functional runs skip those five tests.
The 105k fixture contains 105 traces × 1,001 Spans and measures completion of the concurrent list
independently of completion of the trace request.

## Scope exceptions and remaining work

Required seams outside the initial Area:

- `apps/daemon/src/traces/database.ts`: indexed metadata, atomic migration and ingest maintenance.
- `apps/daemon/src/traces/worker.ts` and `workerProtocol.ts`: worker-side view, bounded list and
  single-Span metadata requests; no public wire contract changes.
- `apps/daemon/src/mcp/sessions/traces.ts`: route tools through those worker requests.
- `apps/daemon/src/traces/history.rt2.test.ts`: regressions for the storage/history changes.
- This report and removal of the review-only repro copies: explicitly required by the brief.

No Desktop launch, screenshot script, Daemon install/upgrade or live vendor session was run.
No baseline was changed. Performance acceptance, any required tuning, removal of the remaining
performance repro copy and the final Claim await the Lead's controlled performance window.

## Controlled performance window

The prepared runner is `/private/tmp/tf2/perf-window.py`. Run it under one Host lease after the
Lead has held the other lanes:

```sh
bun apps/daemon/src/main.ts lease bench -- python3 /private/tmp/tf2/perf-window.py
```

It runs these commands sequentially, recording the command, UTC start/end, exit code and load
averages around each measurement in `/private/tmp/tf2/perf-window/measurements.json`:

1. In the clean assigned-base worktree `/private/tmp/tf2-perf-before`, temporarily copy the same
   performance test file and run
   `POLARIS_TRACE_PERF=1 bun test apps/daemon/src/mcp/tools/traces.performance.test.ts --test-name-pattern 'F4|F7|F8'`.
2. In TF2, run
   `POLARIS_TRACE_PERF=1 bun test apps/daemon/src/mcp/tools/traces.performance.test.ts --test-name-pattern F6`.
   This includes the original 5k fixture and the 105,105-Span fixture with independent concurrent-list timing.
3. In TF2, run the same F4/F7/F8 command as step 1.
4. Remove the temporary test from the base worktree. In the base and then TF2, run
   `bun run bench traces --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-eng656-traces.json`.
   The runner also passes `--json` to save separate before/after results.

The base worktree remains at `c4a1ce26f2a8820181b874b28166ee809b8fba6f`. The runner removes its
temporary performance test in a `finally` block. It does not update any committed baseline.

## Correctness checkpoint validation

The sequential Host-leased run completed Daemon typecheck successfully and ran
`bun test --timeout 60000 apps/daemon/src/traces apps/daemon/src/mcp`: **226 passed, 7 skipped,
0 failed**, 1,993 assertions across 41 files (46.66 seconds). The seven skips are the five opt-in
performance tests and two Postgres-dependent MCP tests; no live database or vendor session is
claimed. The longer functional runner timeout avoids the earlier Host-contention false failures;
the explicit performance thresholds and timeouts are unchanged.

The original detail/input and summariser repro copies under `docs/reviews/` are now removed,
with their passing regressions next to the code. The performance copy remains until its quiet
window run passes. Initial quality found two missing blank lines in the new performance test;
these were corrected. Final quality and root lint passed before the checkpoint commit.
