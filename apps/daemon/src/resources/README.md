# Host resources

`HostResources.layer` depends on `EventStore`. Resource declarations, FIFO requests,
grants, cancellations, removals and releases live in the Host stream. The store's
`ReadModel.hostResources` folds them for snapshots and reloads them on startup.
`__workers` is reserved for the worker cap and scoped worker leases; ordinary declarations and lease
requests cannot use it.

Settings → Hosts reads `host.resources.get`. The declare, remove, release and
`host.workers.setCap` RPCs return that same `HostResourcesSnapshot`. Release frees
a lease or cancels a queued request without sending a signal to its process.
Removal rejects holders and waiters. Capacity reductions reject excess holders;
worker-cap reductions reject excess working workers. A null worker cap restores
`floor(available cores / 3)`, at least one. The default hold limit is 30 minutes.
Every process grant rechecks capacity and the FIFO head under the EventStore commit
lock, so a concurrent Lead plan cannot let a stale capacity grant an extra lease.
Overdue lease IDs are computed when read and logged once while held; the warning
offers Release and never kills the command.

## Worker startup integration

The startup runtime acquires `acquireWorker(sessionId)` in a scope **before** it
starts Harness work. Keep that scope while the Attempt is working, then close it
on Claim, settle or stop. It must not live for the entire Agent Session. Acquisition
parks in a FIFO queue, is cancellable, and automatically grants the next waiter
when a scope closes. `get.workerCap.waiting` supplies "waiting for a slot" to Clients.
The Constellation startup adapter owns that scope and its lifecycle; this service
does not decide Attempt or Session State.

Worker acquisition records `ResourceLeaseQueued` and `ResourceLeased` on
`__workers`, with lease ID equal to request ID and the working Attempt ID when
available. Scope close records release or cancellation before granting the next
waiter. These facts let Stats derive slot waits from the existing Host stream.
The fold keeps each waiter's `queuedAt` (its `ResourceLeaseQueued` envelope's
`occurredAt`, live and on reload) so the Lead's `status` shows how long it has
queued. It is read-only: FIFO order and grants never consult it, so the C1-P
resource model is unchanged.
Settings snapshots hide these internal leases and retain `workerCap` counts.
Resetting the cap declares its automatic capacity without removing held slots.
Startup releases all recovered worker holders and cancels worker waiters before
the Layer is ready; E's `resumeWorking` then reacquires fresh scopes. Worker slots
never run the process monitor or hold warnings.

Pass `POLARIS_HOST_SOCKET`, `POLARIS_SESSION_ID`, and optionally `POLARIS_BINARY`
to worker commands. `tooling/leases.ts` makes the bench and Desktop smoke entry
points re-enter through `polaris lease` under that environment. Outside Polaris,
they take `/tmp/polaris-bench-lock` and `/tmp/polaris-smoke-lock`, respectively.
`POLARIS_LEASE_HELD` prevents an entry point from recursively taking its own lease.
Startup declares those script leases (`SCRIPT_RESOURCES`: `bench`, `smoke`) with capacity 1
when the Host has no declaration for them; an edited capacity is kept across restarts.

## Process lifetime

`polaris lease <name> -- <command> [args...]` starts a gated `/bin/sh` child. The
shell waits on a private descriptor until its FIFO request is granted, then execs
the command in the same PID. Arguments are passed as an argv array. Standard input,
output and error are inherited. The wrapper forwards SIGINT/SIGTERM and preserves
the exit code. The shell is started with `Bun.spawn`, and the wrapper also checks every
two seconds whether the command's process is gone (`lostExit.ts`): if Bun never reports
the exit (ENG-357), the wrapper exits with 1 instead of waiting forever. The check runs
in the wrapper, never in the Daemon.

The persisted PID and process start time identify the child independently of the
wrapper. A wrapper SIGKILL before grant closes the gate; after grant, the command
keeps its lease. Queued wrappers reconnect to the same request after a Daemon
restart. Recovery retains live holders, cancels dead waiters and releases dead or
reused PIDs before granting a successor. Legacy records without process identity
are released conservatively rather than treating a reused PID as their holder.

Only while process holders or waiters exist, a one-second monitor checks process identities.
There is no idle monitor timer, per-session polling, or worker-slot timer. Release
on normal exit is immediate; an unobserved exit is reclaimed at the next check.
The identity probe uses `ps` and is covered on macOS here; Linux is unverified.
`ps` runs through `Bun.spawn`: under load, `node:child_process`'s `execFile` lost its exit
(ENG-356, ENG-357; measured in `docs/research/bun-child-process-lost-exit.md`). Each run
still has 5 s, three times, so a run that never answers is killed and asked again. If none answers, the identity
is unknown and nothing is decided on it: the waiter stays queued, the holder keeps its
lease, and the next check asks again. An unknown identity never counts as an exit.

## Verification

`resources.test.ts` checks capacity, FIFO, cancellation, warning/Release, live and
reused-PID recovery, worker scopes and externally committed Lead declarations.
`cli.slow.test.ts` uses only throwaway Daemons and test processes to exercise wrapper
SIGKILL, child SIGKILL, FIFO after restart, dead waiters and command exit codes.
The protocol tests decode old records and round-trip cancellation/removal.
The C1-P Quint resource model and trace replayer map these same Host events.
`resources.model.slow.test.ts` compares the real broker with an independent queue across
randomized capacity edits, cancellation and restart. Set `POLARIS_RESOURCE_TRACE_DIR`
to capture its durable batches for `packages/spec/scripts/replay-constellation.ts`.

Blocked waits keep their assignment and MCP binding but replace their admission scope.
A blocked worker releases only after foreground work, live Subagents and background
tasks end. A background completion reserves admission until the native reporting
Turn ends or the Harness goes Dormant/fails; empty membership alone is insufficient.
Acceptance and Lead delivery await and pin a new FIFO grant before committing the
unblock Turn. A stopped queued resume closes its scope and cancels the wait.
Restart rebuilds blocked bindings without acquiring an idle slot. Idle unclaimed
working Attempts keep their existing policy. `workerAdmission.model.slow.test.ts` checks
an independent FIFO against real worker leases across randomized blocks/wakes/stops.
