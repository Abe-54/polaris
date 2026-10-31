# TF1 fix round (ENG-656)

Base: `b297928749a85d62ab9c2dda6acf454dcc34cb06`. The traces implementation at this
base is identical to `08798fa8f` (`git diff 08798fa8f..b2979287 -- apps/daemon/src/traces`
is empty). The native before run reproduced all 19 RT1 failures.

The three repro files moved from this directory into `apps/daemon/src/traces/rt1-*.test.ts`.
The F9 test now checks stable tokens across restart, one binding entry, revocation
and a different token after re-issue, following the lead's seed/epoch decision.
The age-retention repro uses `coalesce(sum(bytes),0)` so an empty store is measured
as zero, and now requires zero retained bytes rather than allowing four budgets.

| Finding | Fix | Regression evidence |
| --- | --- | --- |
| F1 | SQL/CLI/environment/vendor patterns, sensitive keys, joined command arguments, opaque bytes dropped | Migrated redaction cases, vendor/key matrix, randomized property test through HTTP into raw SQLite bytes |
| F2 | Trace-specific URL scrub; prose patterns do not rewrite URL paths | URL, ESM and credential-bearing URL cases, including innocent `auth=`/`password=` path components |
| F3 | Event-store lifecycle owns revocation; HMAC seed and per-binding epoch preserve restart/dormancy endpoints | Real store: dormancy, graceful Layer teardown/restart, archived/failed sessions and Workspace removal; Claude/Codex Harness scopes |
| F4 | Age applies to every unpinned record; ordinary records pruned first, errors capped at twice budget | Old-error repro, recent-error oldest-first ceiling, explicit pin survives |
| F5 | Authority/content checks before slots; refusals close; total body deadline; one request per token and per-checkout byte allowance | Anonymous slow-body repro; authenticated drip receives 408 while a second token ingests |
| F6 | Storage errors return 503; failed transaction retains pending batches; next request retries; failed quiet close leaves worker alive | Open failure repaired without retirement; SQLite abort trigger proves both checkouts survive and recover |
| F7 | Bind retry starts at 250 ms and backs off to 30 seconds; scope close cancels retries | Port-conflict repro succeeds after owner exits |
| F8 | Actual worker close invokes `releaseMemory` | Native release confirmed; final RSS gate still fails, also reproduced on original code; ENG-682 tracks the discrepancy |
| F9 | One epoch/active entry per binding; constant-time token comparison; lifecycle cleanup of exporter preferences | Restart/revoke/re-issue, seed deletion, real Workspace removal |
| F10 | Turn-boundary cache uses the read model; only a missed recent-history window rereads SQL | Real event commits with SQL history reads forbidden after initial load; end and next Turn update attribution |
| F11 | Sessions resolve their containing Workspace/worktree root | Subfolder session equals terminal checkout in real event-store fixture |
| F12 | Endpoint appears only on initial watch page; Desktop retains it per watch and refreshes after receiver recovery | Real RPC watch receives two pages; second contains no token. Four Desktop boundary regressions cover batched updates, isolation, availability recovery and bounded retry |
| F13 | Decoder caches the serialized record and byte count for queue accounting and SQLite | Decoder/store suite and native ingest benchmark |

The wire shape is unchanged. T2's history seams are preserved: no rename of
`queries.ts`, `workerProtocol.ts`, `worker.ts` or `store.ts` interfaces.

The first post-fix trace benchmark passed. A subsequent faster run exposed a
429 caused by continuous worker messages delaying the zero-delay flush timer.
The 1,000-record threshold now flushes synchronously; small batches retain their
25 ms batching window. The final measurements include that fix. The final post-quiet RSS comparison
still fails; the original implementation also failed when rechecked. Native
physical footprint after release was 74.9 MiB despite 289.9 MiB resident size.
All raw results are retained. ENG-682 tracks this unresolved benchmark gate;
no baseline was raised and no all-green performance claim is made.

Limits: ingest acknowledges the bounded pending window, not a durable commit for
small batches. A forced shutdown or worker crash can still lose that window.
Explicit pins can exceed retention budgets. Redaction remains a heuristic for
recognizable credentials; binary values are dropped. The pre-release hash-only
vault rotates once when migrating to the seed format. No real exporter service,
production Pi, or release-package build is claimed by this fix round.

## Validation and Area exceptions

Before the first Claim, `bun run typecheck` passed all 18 tasks and `bun run lint` passed.
The earlier full `bun run test` passed all 19 tasks (Daemon: 3,188 pass,
87 existing opt-in/environment skips). After the worker close-event correction,
the pre-Claim full run reported 18/19 tasks successful: Daemon 3,187 pass, 87 skip,
one failure in the unchanged push end-to-end test at `push.e2e.test.ts:313`.
It received and decrypted the fake APNs message, but the relay's `sent` log was
not yet captured. Its immediate native isolated rerun passed all 21 assertions
in 8.77 seconds. [ENG-683](https://linear.app/luxdev/issue/ENG-683) tracks that
suspected synchronization race; the full-run failure is not waived by the rerun.

All 65 trace tests passed, including in that full run; the focused Desktop
Traces suite passed 80 tests. The 19 migrated RT1 repros failed on the original
implementation before these fixes. Native sockets and PTYs were enabled for
validation. Existing skips include real database/vendor services and
platform-specific cases; they are not claimed as verified.

The failed RSS comparison is tracked in
[ENG-682](https://linear.app/luxdev/issue/ENG-682). No baseline was changed.
The trace performance gate remains unresolved; the latest full test result is below.

### Revalidation after SX

On 2026-10-31, after the operator lifted the full-check restriction, all three
root checks ran sequentially against `2255b2e9554268e16c5d367b912eace01dcbb329`:

- `bun run typecheck`: 18/18 tasks passed, 17 cached; 1m31.833s.
- `bun run test`: 19/19 tasks passed, 18 cached; 9m41.838s. The Daemon ran fresh:
  3,188 pass, 87 existing skips, zero failures across 566 files, including all
  65 trace tests and the push end-to-end test that failed in the earlier run.
- `bun run lint`: format check and lint ratchet passed.

This follow-up changes only this validation report. No screenshot or Desktop
launch was needed. The earlier intermittent push failure remains recorded in
ENG-683; this passing run does not establish that its race is fixed. Benchmarks
were not repeated, and ENG-682's RSS gate remains open with the baseline unchanged.

### Area exceptions

The Desktop boundary compatibility fix changes two paths outside TF1's Area:
`apps/desktop/src/renderer/features/traces/data/api.ts` and its `api.test.ts`.
It is necessary to keep F12 from removing the existing setup copy action after
the first update. The workflow allows documented Area exceptions. A coordination
question could not reach the lead (Polaris MCP transport unavailable); after
preparing the patch and allowing time for user steering, TF1 includes the small
compatibility fix under the already-authorized F12 behavior. It introduces no
new UI, copy, theme or density treatment. Product authority: DESIGN.md Traces
Setup and product-design's rule/design-reachable-states.

## Send-back: T2 HTTP fixture on integration merge 83b165416

The requested merge of `83b165416322918d7bfb8bf3efad8e7d608c46b2` fast-forwarded
this branch. It preserves T2's history handler and the combined T4F usual-duration
and TF1 endpoint-first-page RPC tests.

The original `mcp/tools/traces.http.test.ts` reproduced the reported
`E-TRACE-NOT-FOUND` failure before any change. Its fixture committed
`SessionCreated` events without ever registering their Workspace. F11's
containing-root resolver correctly refuses that orphan checkout. The previous
resolver used the raw session cwd and therefore concealed the incomplete fixture.
The production `StartSession` decider rejects an unknown Workspace before it
creates a session; the fixture bypassed that guard by committing events directly.

The correction is confined to that test: register a real Workspace, use its ID
for the sessions, and put their cwd in an existing `package` subfolder. All
existing HTTP, SQLite, current-Turn, redaction and forged-checkout assertions
remain. The returned Span must still name the registered root rather than the
session subfolder. The focused test passes all 21 assertions for Plain, Lead and
Worker bindings. Temporarily reverting root resolution to raw session cwd makes
that checkout assertion fail; product code was then restored byte for byte.

Area exception: `apps/daemon/src/mcp/tools/traces.http.test.ts`, explicitly named
and authorized by the Lead's send-back. No product code, protocol shape, history
interface or lifecycle rule changes in this correction. Benchmarks are not
repeated for this fixture-only change; the recorded ENG-682 limitation remains.

Validation on the corrected integration tree ran sequentially: root typecheck
passed 18/18 tasks (5 cached); `bun test apps/daemon/src/traces apps/daemon/src/mcp`
passed 211 tests with two existing real-Postgres/MySQL skips, zero failures and
1,945 assertions across 37 files; root format check and lint ratchet passed.
The merged usual-duration and endpoint-first-page RPC tests both pass. The full
monorepo test suite was not repeated for this fixture-only correction; the
send-back requested the Traces and MCP suites. Raw logs for this round are in
`/private/tmp/tf1/sendback/`.
