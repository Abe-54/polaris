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
and any stronger live-target identity checks. No new attach RPC is provided here.
