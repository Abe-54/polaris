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
seconds; it does not stop a long-running command. Native process exit flushes the
artifact. Profiles from child processes are not aggregated into the main recording.

`restart(sessionId,pid)` only accepts a live retained Bun subprocess handle from
this service in the same checkout. A restart rebuilds the tracing overlay from the original upstream source environment
and the restart invocation's verified Turn (P2's optional third environment argument),
so it does not reuse a signed endpoint claiming the original launch Turn.
The Daemon rechecks policy and identity before
signalling its process group. Concurrent restarts are refused; a process that does
not stop within five seconds stays owned until exit/shutdown. Nothing adopts an
external PID. After a Daemon restart, previous in-flight summaries show failed.
P2/P9 can replace this local launch seam with their authenticated launch authority.

The worker validates CPU graph ids, parents, cycles/depth, finite nonnegative
sample deltas and timing bounds. Weights produce self and inclusive time; recursive
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
cached detail, and at most 200 recordings; reads do not pin. No idle sweep runs.
One active profile worker job runs at a time with at most 32 queued jobs, four live
captures, command labels capped at 4096 characters (exact argv stays private for restart),
64 MiB per artifact, 200k CPU nodes, 2m samples and 500k flame frames.

The one-shot worker is an explicit compiled entrypoint in scripts/build-daemon.ts.
`docs/specs/profile-smoke.ts` starts only a throwaway compiled Daemon under /tmp and
rebuilds a small real Node artifact through profiles.get, then a synthetic 50 MB
recording with one million samples while measuring concurrent files.stat RPCs.
It never installs a build.
The MCP text and error contract is docs/specs/traces-tools-v1.md. Span-level trace
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

## Approved cooperative inspector capture (P9 / ENG-659)

`attach(sessionId, pid, seconds)` and `profiles.attach` request a new Pending
Approval for every capture (1–30 seconds, default 5). The card names the Node
command, pid and duration and says **while attached, any local process can run
code in it**. Only Allow once authorizes capture. Remembered Allow, Answer,
read-only, Reviewer, untrusted Workspace and a completed Turn are refused.
Approval requests/responses/withdrawals go through the existing Session machine;
the Engine never forwards these responses to a Harness. Cancellation and Turn
end withdraw pending requests or close a running capture.

This is deliberately **cooperative-only**. There is no SIGUSR1 or arbitrary-PID
path. An unregistered process is refused with "Restart with profiling instead."
Arbitrary Node apps can change `process.debugPort` or bind an inspector publicly;
SIGUSR1 cannot guarantee that Polaris can discover and close that listener.
Only the owner can accept those residual risks; arbitrary-PID attach is deferred.
Windows is refused. Node must expose `process.getBuiltinModule`; older runtimes
do not register. Bun never receives a signal or a Node inspector request.
A process that opts out with `--disable-sigusr1` is refused even though this path
uses no signals.

The same `TraceRuntime.environment` conditions that inject the OTLP endpoint
(Listening, no user-exported endpoint, active session) inject a small Node
bootstrap only for writable, non-Reviewer sessions. Terminal environments do
not inject it. `traces/nodeOptions.ts`'s `appendNodeImport(options, path)` is the
shared P3/P9 composition seam: preserve existing NODE_OPTIONS and append a quoted
`--import` path. The bootstrap runs silently if the control socket is absent or
registration fails. A content-addressed private file survives Daemon shutdown so
children retaining NODE_OPTIONS can still start. No inspector, watchdog worker
or timer starts at registration; the control socket is unreferenced in Node.

A private Unix socket and a random per-launch capability bind registration to
its Agent Session. The Daemon corroborates pid, OS-user, executable and launch
identity and the launch capability from kernel process information, before approval and again before
capture. This version accepts only the Node executable currently resolved on
the Host's PATH; other Node installations are refused. Capabilities and sockets
are bounded and are not persisted across Daemon restarts.

After Allow once, an in-target Worker opens an inspector with
`inspector.open(0, '127.0.0.1')`, then reports `inspector.url()` over its authenticated
control connection. An existing inspector is refused and left untouched.
Port 9229 is never required or signalled. The Daemon checks the returned endpoint
and CDP process identity and records a bounded CDP Profiler window. The Worker
owns inspector shutdown, independently of the application's main event loop:
control disconnection, missed active-capture heartbeats (1.5 s), a capture deadline
or an explicit close all deactivate the inspector. The Daemon closes on CDP
failure and cancellation. The approval's local-code-execution risk still applies
while that port is open; loopback is not an authorization boundary.

Capture artifacts use `Profiles.record`, its one parser worker, checkout storage,
retention and `origin: "attach"`. P5's existing Profiles list and flame chart render
them. The sidebar's "Profile ‹service› for 5 s…" action only requests approval;
it cannot authorize attach itself. `profile {attach: pid, seconds?: n}` is the
agent equivalent. No registration creates restart or signal authority.

`bun apps/daemon/src/main.ts lease bench -- bun apps/daemon/src/traces/attach/startup.ts`
measures the startup budget with 20 alternating `node -e 0` starts per condition.
