# CPU Profiles

`Profiles` is one Host service composed beside the Engine. It uses the existing
`TraceSessions`, `TraceRuntime`, event store, `WorkspaceTrust` and approval policy.
No Profile enters the event log. Capture and restart refuse plan-mode, Reviewer,
policy-read-only and untrusted sessions. Reads remain available in those sessions.

`capture(sessionId, argv, waitSeconds?)` executes a Node or Bun argv directly in the
verified Agent Session cwd; binding and storage stay at the canonical checkout root.
`Profile.cwd` records that execution directory. Restart reuses it and revalidates
containment before stopping and relaunching. `--cpu-prof` comes from `NODE_OPTIONS` or `BUN_OPTIONS`;
`--cpu-prof-dir` is a single argv entry because Bun retains quotes in BUN_OPTIONS.
Output is discarded rather than retained without bounds. The wait defaults to 30
seconds; it does not stop a long-running command. A private per-recording preload
turns SIGINT into a normal exit so Node and Bun flush `--cpu-prof`. Restart and
Daemon shutdown send SIGINT, allow five seconds for exit/write, then SIGTERM for
five seconds, then SIGKILL. A process that blocks or replaces the handler can still
require escalation and lose its profile. Profiles from child processes are not
aggregated into the main recording.

`restart(sessionId,pid)` only accepts a live retained Bun subprocess handle from
this service in the same checkout. A restart rebuilds the tracing overlay from the original upstream source environment
and the restart invocation's verified Turn (P2's optional third environment argument),
so it does not reuse a signed endpoint claiming the original launch Turn.
The Daemon rechecks policy and identity before
stopping its owned process tree and reserves the replacement's live-capture slot
before stopping it. POSIX uses SIGINT so the owned preload exits normally and flushes
its profile. Windows uses a private IPC startup gate and exit request; before the
gate opens, the Daemon encloses the process in a kill-on-close Job Object. Closing
the job after normal exit also retires descendants, including detached children. Concurrent restarts are refused. Nothing adopts an external
PID. Shutdown drains completion jobs before closing the worker queue. List/get
recover flushed artifacts from orphan recordings left by an earlier Daemon.
P2/P9 can replace this local launch seam with their authenticated launch authority.

The worker validates CPU graph ids, parents, cycles/depth, finite sample deltas
and timing bounds. Node can emit samples out of timestamp order on Windows, including
negative deltas; these become cumulative timestamps, sorted with their sample IDs
in place, before weights are calculated. Timestamps outside the capture remain invalid.
Both ordered and out-of-order maximum-size profiles retain the 700 MiB RSS gate.
Validation keeps parent/depth maps, never a stack
copy for every node; only the current sampled stack is materialised. Consecutive
samples of the same stack coalesce, and existing frame durations update in place.
Weights produce self and inclusive time; recursive
appearances count inclusive time once per sample. Adjacent matching stack frames
merge into chronological nodes. Functions sort by total time then self time; nodes
and the hottest stack use the remapped stable table. Paths become checkout-relative
where possible; parsed labels and URLs use the Traces credential scrubber. Native
artifacts remain in their original format. Bun epoch and Node monotonic profile clocks are translated to UTC
inside the measured launch interval, with the launch timestamp as fallback.

The private tree is `profiles/<sha256(canonical checkout)>/<random id>/` under
POLARIS_HOME. Metadata, raw artifact and cached detail stay together. Reads resolve
ids in that checkout, never a returned path. Missing detail caches rebuild from the
raw artifact. Symlink/hardlink/oversized artifacts are refused before read or chmod. Retention
prunes on access/completion: seven days, 200 MiB per checkout including artifacts and
cached detail, and at most 200 finished recordings; active recordings do not consume
that budget. Reads do not pin. No idle sweep runs. One profile worker job runs at a
time with at most 32 queued jobs; completions and discards wait for queue space.
Parsing does not consume the limit of four live
captures, command labels capped at 4096 characters (exact argv stays private for restart),
64 MiB per artifact, 200k CPU nodes, 2m samples and 500k flame frames.

The one-shot worker is an explicit compiled entrypoint in scripts/build-daemon.ts.
`docs/specs/profile-smoke.ts` starts only a throwaway compiled Daemon under /tmp and
rebuilds a small real Node artifact through profiles.get, then a synthetic 50 MB
recording with one million samples while measuring concurrent files.stat RPCs.
It never installs a build.
MCP text stays within 16,000 characters and structuredContent within 16,000 UTF-8
JSON bytes: clipped metadata, top self/total frames, hot-path frames, overlap and
original counts. Each frame includes its full-detail table index. The separate
`profiles.get` RPC retains full function and chronological-node tables; open the
recording in Traces for the full view. Span-level trace
overlap queries run in the existing trace worker, capped at 200 with a match count.

## P9 scoped recording seam

P9 calls `Profiles.record(sessionId, {command,runtime,pid,service?})` inside its
attach Scope after its inspector checks. This internal-only API returns
`{profile,directory,finish}` and marks origin attach. P9 writes the `.cpuprofile`
into that directory, then may yield `finish` to obtain the final Profile. `finish`
is idempotent. A successful Scope close also finalises; a failed/interrupted Scope
removes its recording and directory. It uses this service's worker, retention,
checkout authority, Trust and session policy. It never adopts the supplied PID,
registers a launch handle, restarts or signals a process. P9 owns inspector access
and any stronger live-target identity checks. The public attach path is described below.

## Cooperative CPU capture (P9 / ENG-659)

Agent `attach(sessionId, pid, seconds)` requests a fresh Pending Approval for
1–30 seconds (default 5). Only Allow once authorizes it. Remembered Allow, Answer,
read-only, Reviewer, untrusted Workspace and a completed Turn are refused.
The Session machine owns approval and preserves In Terminal. Upgrade withdraws
orphaned inspector approvals. Cancellation and Turn end cancel agent captures.

The sidebar uses `profiles.attach` → `attachUser`: its inline disclosure and click
are consent. It works while idle, creates no Pending Approval, and survives Turn
end. It requires the same Client trust and approve Grant as RespondToApproval.
Same-user local callers can already answer approvals over the bare socket;
ENG-700 owns that authorization decision and is outside this change.

Only cooperative Node processes register. No SIGUSR1 or arbitrary-PID path exists.
Windows, Bun, older Node without getBuiltinModule, and --disable-sigusr1 or
permission-restricted processes are refused. Existing inspectors are left alone.
TraceRuntime injects the bootstrap only for active writable non-Reviewer sessions,
without a user-exported endpoint. NODE_OPTIONS imports are preserved; terminal
environments do not inject it. The private content-addressed preload survives
Daemon shutdown. Registration creates no Worker or timer in the target.

The private Unix socket verifies LOCAL_PEERPID on macOS or SO_PEERCRED on Linux
for both registration and capture. Identity uses pid, start time, executable
inode/device, OS user and the launch token; argv is display-only. Tokens
expire with their Agent Session, not after a launch count. The registry caps
registration sockets at 256 and watchdog sockets at one, reserving the watchdog
lane by kernel peer PID. Unclassified sockets expire after two seconds. No capabilities persist on restart.

A Worker marked by the launch token connects an in-process inspector.Session to
the main thread and runs Profiler.enable/start/stop. No TCP inspector opens, no
endpoint exists to discover, and nothing is written to target stderr. Profile
chunks cross the private socket with a 64 MiB total bound and socket backpressure.
The Worker disconnects on control loss or a missed 1.5 s heartbeat; the registry
bounds capture duration plus five seconds. A main thread blocked in native code
may delay completion, in which case capture fails cleanly without network exposure.

Artifacts use Profiles.record, its parser worker, checkout storage, retention and
origin: attach. No registration grants restart or signal authority. Startup cost:
`bun --no-env-file --config=./scripts/daemon-dev.toml apps/daemon/src/main.ts lease bench -- bun apps/daemon/src/traces/attach/startup.ts`.
