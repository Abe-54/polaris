# UF15 — CPU Profiles after RP4 (ENG-657)

Integration base: `9f63dccfe` (accepted UF11, UF12 and SEC2 included). The five P4 repros moved into
`apps/daemon/src/traces/profiles/regressions.test.ts`; the review copies were deleted.
All processes, recordings and HTTP servers in this verification use disposable directories.

## Findings and regressions

| Finding | Change | Evidence |
| --- | --- | --- |
| P4-1 | Owned launches load a private SIGINT exit handler. Restart and shutdown allow five seconds for a normal exit/profile flush, then SIGTERM for five seconds, then SIGKILL. Shutdown admits and drains completion jobs. | Original Node and Bun restart repros fail on baseline and pass with the fix. Added real Node/Bun shutdown assertions on persisted completed metadata and parsed `polarisBurn` frames. |
| P4-2 | Completion jobs wait for queue space like discard jobs; orphan recordings with flushed artifacts recover on list/get. | Saturated 32-job queue repro passes; both recovery entry points have outcome assertions. A shutdown race regression fails with persisted `recording` before retaining exited launches through completion, then passes with persisted `completed` and a detail cache. |
| P4-3 | Active recordings are excluded from finished-recording byte/count budgets. | An oversized active artifact no longer evicts a small finished recording. |
| P4-4 | The four-capture cap counts live processes, attached recordings and starts, excluding parsing and duplicate starting/recording bookkeeping. Refusal names the limit. | Original cross-checkout refusal repro plus a capture admitted while an exited command awaits parsing. |
| P4-5 | MCP returns bounded metadata, top self/total frames, hot-path frames, overlaps and counts. Full detail remains on `profiles.get`. | JSON is at most 16,000 UTF-8 bytes at 200k functions/500k nodes, including multibyte and escaped labels. Removing the summary returns 208,656,757 bytes and fails the byte assertion. |
| P4-6 | Validate the parsed object without a decoded graph copy; retain parent/depth maps rather than a stack for every CPU node; coalesce adjacent identical samples and update flame frames in place. | Real-worker largest-artifact RSS assertion, plus the existing timing, recursion, graph validation and event-loop tests. |
| P4-7 | Recheck/reserve the replacement slot before signalling; retain that reservation through completion and relaunch. | An interleaved contender is refused while the old artifact parses. Removing the reservation admits it (`recording`) and fails the refusal assertion. |

The original five tests ran against the baseline with **0 pass / 5 fail**, each on
its named behavior. The current focused run has **39 pass / 0 fail** across the
profile service, parser, worker, RSS and MCP tests (33.88 s).

## Memory and cost

Measured on macOS arm64, Bun 1.4.4. These are process peak RSS values, not heap sizes
or measurements on Linux/Pi. The real worker runs in its own freshly spawned Bun
process for the RSS test, so fixture construction in the test parent is excluded.

| Fixture | Baseline | Fixed |
| --- | --- | --- |
| 19,266,497 bytes, 200k nodes, shared deep ancestry, one sample (direct parser) | 1,269.45 MiB, 2.80 s | 361.83 MiB, 2.07 s before the additional in-place validation change |
| 64 MiB artifact, 200k nodes, depth 256, 2m samples (production worker) | 2,362.77 MiB; worker timed out at 60 s | 455.70 MiB, 1.67 s in the final focused run |

The focused maximum-artifact peak was **80.7% lower** than the full baseline peak;
the later full-suite peak (608.99 MiB) was **74.2% lower**.
Earlier fixed runs measured 553.03 MiB (5.55 s) under concurrent Host load; the test
requires less than 700 MiB, below 30% of the measured full baseline peak. Restoring only per-node stack copies while keeping the
other improvements measured 788.30 MiB and failed that RSS assertion. Repeating
that negative control against the revised 700 MiB bound measured 1,293.21 MiB
and failed on the RSS assertion. The final production-worker check on the shared
Host completed at 509.53 MiB in 0.593 s. The complete
baseline parser also fails the maximum-artifact test by reaching its existing
worker timeout; that negative-control timeout is expected and is not a passing
performance result. No production worker timeout was raised.

Parsing is an on-demand one-shot worker, not an idle timer or shared ingest worker.
The maximum-artifact worker exercise and existing 50 MB worker responsiveness test
cover its changed cost. No generic idle baseline is changed.

## Full Daemon smoke

`daemon-smoke.ts` starts source Daemons with fake Harnesses but real RPC, MCP,
profile workers, a seeded disposable Trust record and Node/Bun HTTP servers on ephemeral loopback ports. It calls
`profile command`, `profile process`, reads the ended profile through `profiles.get`,
then sends the Daemon SIGTERM and inspects the persisted profile from the new server.
It uses `lsof` only to find the disposable Daemon's MCP listener and does not install
or replace a Daemon. Run on macOS:

```sh
bun docs/reviews/2026-10-31-traces-RP4/p4/daemon-smoke.ts
```

The native traces/MCP run is **399 pass / 7 existing opt-in skips / 0 fail**
(406 tests across 64 files, 96.75 s). The first run had one stale attach-test decoder
expecting full `ProfileDetail` from MCP; the minimal update was coordinated with
UF14, its isolated rerun passed 13/13, and the full suite then passed. The skips are
two external-database integration tests and five existing opt-in trace cost tests.
Root typecheck passed (18 tasks; 22.63 s) and root lint passed (48.13 s) on
`a3320418c` plus these changes. Root tests ran for 606.98 s: the Daemon had
3,414 pass / 92 existing skips / 1 fail; other packages passed. The sole failure was
the new worker RSS test measuring 608.99 MiB against its initial 600 MiB threshold.
That peak is still 74.2% below the measured 2,362.77 MiB baseline. The bound is now
700 MiB to allow the observed allocation/GC variation while staying well below half
the baseline. The stack-copy negative control and integrated traces/MCP suite are
rerun below; no production algorithm or timeout changed for this adjustment.
The final full-Daemon smoke passed on `9f63dccfe` plus the final fixes:

| Runtime | Restart | Daemon stop | Parsed frames (restart / stop) |
| --- | --- | --- | --- |
| Node | completed | completed | 75 / 87 |
| Bun | completed | completed | 44 / 31 |

The smoke and final targeted checks run as disposable correctness checks on the
shared Host, alongside another worker's root suite. They do not claim isolated
latency or throughput measurements. The root batch above held the `bench` lease.
The final integrated traces/MCP suite passed **436 / 7 existing skips / 0 failures**
(443 tests across 67 files, 101.52 s), including the added shutdown race regression.
Root typecheck passed again on the final code (18 tasks, 17.64 s), and root lint
passed (69.52 s). The full repository test run is not described as green: its single
RSS-threshold failure and the subsequent correction/negative control are retained
above; the affected suite was rerun in full.

The smoke seeds Trust for its disposable checkout through the real file Trust
repository. Its first attempt using the language Trust RPC was refused by connection
authority before any profile launch; no production code changed for that fixture fix. A second fixture failure was listener
discovery: adding `lsof -nP` made its output numeric, as the parser requires; the
completed run above uses that correction.

## Limits

No Linux, Raspberry Pi, compiled-binary or Desktop UI run. A process that blocks its
main thread or replaces the owned SIGINT handler may require escalation and lose
its recording; the bounded escalation is intentional. No protocol or Session State
machine changes are made. P9 attach changes belong to UF14.

## Area exceptions

- `docs/specs/traces-tools-v1.md`: update the public profile MCP contract, which still
  promised full detail in every structuredContent result. Only the profile section changed.
- `apps/daemon/src/traces/attach/attach.test.ts`: replace its stale ProfileDetail MCP
  decode with Profile metadata. It already reads the full detail through Profiles.get.
  Coordinated with UF14; no attach transport/approval assertions changed.
