# Approved Node inspector profiles — P9 / ENG-659

## Checkpoint and shipping decision

This checkpoint is based on accepted integration `9a0fac480958ce46e47a478c2c3cb3a412ebae9f`.
P3's accepted shared `appendNodeImport` helper and tracing environment composition
must still be merged and checked before P9 submits its Claim. The temporary helper
in this checkpoint is not a competing integration contract.

**The owner must decide whether this feature ships: while attached, any local
process can run code in the target.** Loopback is not authentication. Every capture
opens a fresh Pending Approval naming the command, PID, Node runtime, duration and
that risk. Only Allow once releases capture; remembered Allow and Answer are refused.
The existing approval card and inbox offer no Always allow action.

This implementation is cooperative-only, as directed by the Lead. Only registered
Polaris-launched Node processes are eligible. There is no SIGUSR1 or arbitrary-PID
path. Registration uses a private Unix socket and per-launch capability, checked
against kernel executable, user, start identity and launch environment. Bun,
Windows, unknown processes, opt-out flags, read-only/plan/Reviewer sessions and
untrusted Workspaces are refused. An existing inspector remains untouched.
The target opens an ephemeral loopback port after approval; port 9229 is unused.

The target's Worker watchdog closes the inspector on control disconnection,
heartbeat expiry, deadline or explicit close, including when the main thread is
busy. Cancellation and Turn completion withdraw pending approvals or close an
active capture. Captures use P4's recording scope, parser, retention and store with
`origin: attach`; the existing Profiles list and flame chart render them.

## Validation on macOS

All full suites, builds, screenshots and benchmarks ran through the shared `bench`
lease. These are reported results, not Daemon command-item receipts.

| Check | Result |
| --- | --- |
| Root typecheck, final source | 18/18 tasks passed, 16 cached |
| Root test | 19/19 tasks passed, 4 cached; Daemon 3,300 passed / 87 skipped; Desktop 4,399 passed / 14 skipped; no failures |
| Root lint | Passed; final changed-file quality also passed |
| Real Node attach and MCP regressions | 18 passed, 112 assertions |
| Quint suite | Passed, including inspector approval scenarios and safety simulation |
| Engine verification and Session graph | 37 passed, 70,411 assertions |
| Engine trace replay | 14/14 conform: 110 decisions, 156 spec events |
| Focused Desktop checks | 11 passed, 32 assertions |

Native cases include approved capture, denial, Bun and unknown-PID refusal,
existing-inspector preservation, `--disable-sigusr1` with original and changed
process title, pending/active cancellation, Turn completion, busy-main-thread
watchdog shutdown, forged-PID registration and older approval decoding.
Removing the kernel launch-capability check made the forged-PID regression fail;
the check was restored before the final suite.

Scripted Electron captured the Profiles action and refusal in Moonlit, Midnight
and light at all three densities, restart refusal in each theme, and keyboard
focus with reduced motion. Tab/Shift+Tab order and a visible focus ring passed.
The approval card was captured in dark and light at all three densities; its
process, risk and one-time decision controls were visually checked. An initially
missing preview scene registration was corrected and those screenshots recaptured.
The root test run predates only that preview registration and JSDoc wording;
final typecheck, build and quality include them.

Logs and screenshots are under `/tmp/p9-{root-tests,root-lint,typecheck-final2,
native-integrated,spec,verification,replay-engine-only,ui}.log`,
`/tmp/p9-profile-screens/` and `/tmp/p9-approval-screens-fixed/` on the Mac Host.
Existing database-configuration and platform skips are included in the counts;
no real PostgreSQL/MySQL result is claimed here.

## Performance

Twenty alternating Node starts per condition measured median startup at 28.093 ms
without and 32.285 ms with the cooperative bootstrap: **+4.192 ms**, below the
15 ms budget. Raw samples: `/tmp/p9-startup-integrated.json`.

Three full idle runs on the same Mac14,13 / M2 Max / Bun 1.4.4 source checkout,
bridge transport, compared the clean accepted base with P9:

| Metric | Accepted base | P9 | Difference |
| --- | ---: | ---: | ---: |
| Client RSS, MiB | 107.984 | 108.133 | +0.149 |
| Client physical footprint, MiB | 65.016 | 65.352 | +0.336 |
| Client CPU, percent of one core | 0.350 | 0.343 | -0.007 |
| Client wakeups/s | 8.167 | 8.233 | +0.066 |
| No-Client RSS, MiB | 107.906 | 108.078 | +0.172 |
| No-Client physical footprint, MiB | 64.720 | 65.095 | +0.375 |
| No-Client CPU, percent of one core | 0.02244 | 0.02271 | +0.00027 |
| No-Client wakeups/s | 0.733 | 0.800 | +0.067 |

The older committed full baseline comparison failed four memory gates. Its
68–94 MiB RSS and 53–54 MiB footprint are already exceeded by the accepted base;
the matched comparison isolates P9's small incremental cost. No baseline was
rewritten. Both runs warned about background load (base 5.8 cores, P9 4.1), so CPU
numbers are not a quiet-machine causal measurement. Samples are
`/tmp/p9-idle-base.json` and `/tmp/p9-idle.json`.

## Remaining boundaries

Arbitrary-PID attach is deferred in ENG-693, targeting Polaris 0.8. Windows is
explicitly refused. Linux has a kernel identity implementation but no native
attach evidence in this report. Node must expose `process.getBuiltinModule` and
match the Host's installed PATH executable. No Pi performance result is claimed.

Outside the assigned Traces/MCP-tool/Profiles-UI paths, the Lead authorized the
minimal protocol, Engine/Session-machine, Quint, RPC/IPC and approval-card seams.
`DESIGN.md` records the approval behavior; this report preserves the validation
and owner risk decision for review. No dependency or copied third-party code was
introduced.
