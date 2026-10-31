# RW fix round (ENG-645)

WF fixes RW F1–F14 from base `075aac5e`. The acceptance decisions and limits are in
[ADR 0091](../adr/0091-agents-query-data-sources-through-the-daemon.md#rw-write-fixes-eng-645)
and the [Data README](../../apps/daemon/src/data/README.md#writes-eng-645).

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F1 | Built-in-only calls; implicit PostgreSQL expressions checked; triggers and all Local Postgres DDL skip preview; MySQL trigger dependencies require InnoDB. | `writeSafety.real`: dblink wrapper/default/trigger/TRUNCATE; MyISAM direct and nested triggers/functions. |
| F2 | Writes off applies before preview/card on Local and Remote, including grid commits. | `writeRemote`: both Local entry points and no log/card. |
| F3 | COMMIT confirmation shield, five-second bound, unknown error/log/status; interruption waits for durable settlement. | `writeCommit` tests, native deferred-COMMIT cancellation and connection loss; unknown service trace. |
| F4 | Optional scrubbed params and previewed fields; INSERT after rows; explicit not-previewed title. | Native INSERT images; service trace asserts persisted params; write-card projection tests. |
| F5 | Explicit write decisions carry locality; read decisions don't change writes; revoke deletes rules. | Policy unit tests and independent approval PBT with Local/Remote/write/revoke changes. |
| F6 | Full key/full-row identity hashes, independent of the display cap; inserted images exclude database-filled columns. | Native same-count drift with/without a key; generated INSERT; replay rejects drift reported as success. |
| F7 | Refuse upserts and key assignments across the full statement; MySQL names are case-insensitive. | SQL unit tests and native key changes beyond the first 20 rows. |
| F8 | MySQL target and subquery database checks; implicit comma joins refused. | SQL and native cross-database probes. |
| F9 | Shared scrubber plus credential-column redaction before capped rows enter events. | Preview unit test, native token columns, recorded requests/events checked for leaked values. |
| F10 | Preflight, trigger/DDL no-preview, identity drift and unknown in Quint; replay derives transitions from committed events, persisted request state and Query Log. | 17 scenarios, 3,000 safety traces, negative replay tests and 9 native traces. |
| F11 | Typed key grouping plus actual matched-row uniqueness catches coercion duplicates. | Property-order-independent Bytes keys; native Numeric/number aliases of one database key. |
| F12 | Complete Bytes payloads bind on both engines; unsupported keys fail with a reason. | Bytes validation and native bytea/BINARY read-edit round trips. |
| F13 | Per-target semaphore, released when idle. | A blocked target leaves another target runnable; same-target calls queue. |
| F14 | Recovery marks unfinished writes unknown; denial names the write. | On-disk Query Log restart, request recovery PBT and no-reason denial. |

## Evidence

Native checks below were run by the Lead on this worktree's uncommitted implementation with
Postgres 16 and MySQL 8.4, using disposable prefixed objects and cleanup. They are **Reported**
evidence, not Verified command-item receipts.

- First native driver/security run: 7 pass, 0 fail (`/tmp/wf-native-first.log`).
- Native service/replay run: 9 pass, 1 skip, 0 fail; 9 traces (`/tmp/wf-native-replays.log`).
- Full Data, MCP and verification run: 439 pass, 1 skip, 1 model failure
  (`/tmp/wf-native-final.log`). The minimized Local→read-allow sequence exposed the old
  reference model's assumption that a read decision also stored writes off. F5 requires the
  read decision to remain explicit while write defaults stay unstored. The reference now models
  explicit write policy separately with locality; revocation removes it. No production guard
  was weakened to pass this check.
- Corrected native run, including changed security/replay suites and both approval/write models:
  16 pass, 1 skip, 0 fail, 9,272 assertions (`/tmp/wf-native-corrected.log`), seed `-1702799098`.
  The skip is the PostgreSQL-specific lost-COMMIT probe on MySQL. The other full-suite passes
  above remain the evidence for unchanged paths.
- Focused local contracts, policy, recovery, locks, Desktop Query Log and model checks:
  95 pass, 0 fail (`/tmp/wf-focused-final.log`).
- Root typecheck: all 18 workspaces. Root lint and dirty-file quality checks pass.
- `bun run spec` passed (`/tmp/wf-spec-final.log`); after adding the final DDL scenario,
  the write module separately passes 17 scenarios and 3,000 safety traces (`/tmp/wf-quint-final.log`).
- The 9 native write traces in `/tmp/wf-write-traces` replay through the final model.
  Engine replay: 14/14 traces, 116 decisions, 186 events (`/tmp/wf-engine-only-replay.log`).
  The initial engine replay pointed at the mixed trace directory and rejected unrelated schemas;
  the final run selected all `engine-*.json` files. An earlier write replay raced the Lead's
  trace-directory regeneration and encountered a missing file; the completed set was rerun.

## Performance and limits

Lead-reported idle benchmark: three quick native runs against the committed m31 idle baseline,
no regression beyond tolerance (`/tmp/wf-bench.log`). No Client: 64.0 MiB footprint, 7.4 wakeups/s
(baseline 97.2 MiB, 10.5/s). With a Client: 64.4 MiB, 10.0/s (baseline 98.1 MiB, 13.1/s).
G1's earlier integration reference at `b6d8ca4a` was 64.4 MiB and 6.8/s without a Client.
This is not an exact-base before/after result. CPU is not comparable: 9.1 cores were busy.
No baseline was changed. The only new timer bounds an in-flight COMMIT.

Complete identity must fit 10,000 rows and the server byte/column budget; INSERT currently reads
a bounded full-table before/after snapshot. Oversize or clipped identities refuse the write.
Sequences consumed by previews are not reused. Upserts remain refused and were added to ENG-669.
Apalache was not run. No live Desktop/Harness card was exercised by WF; OD owns that accepted
renderer work. WF changes its payload and the Query Log's distinct unknown label. The Lead will
reconcile OD at integration; its merge does not touch WF's protocol or Query Log model files.

No assignment paths were declared. Changed Areas are Data runtime/tests/README, Data verification,
protocol contracts, Desktop Query Log model/test, spec/replay and documentation; each is needed
for the listed finding or requested mapping. No read guard was relaxed.
