---
status: accepted
fixes: on macOS a change made just after a watch was armed was never reported (ENG-368)
---

# macOS watches wait for Bun to start its FSEvents stream

## Context

`watchRoot` (`apps/daemon/src/files/search/watch.ts`) backs the fallback search watch, the
usage index and the language configuration watch. Its callers read the tree right after it
resolves and rely on every later change being reported.

On macOS, Bun 1.3.13's `fs.watch` (`src/bun.js/node/fs_events.zig`) keeps **one**
FSEvents stream for the whole process. `registerWatcher` only queues `_schedule` to a
CoreFoundation thread and returns. `_schedule` then stops the old stream and creates a new
one over every watched path with `kFSEventStreamEventIdSinceNow`. A change made between
`fs.watch` returning and that stream starting is never delivered, not even late.

Bun 1.4.3, which the Daemon ships, rewrote this in Rust (`src/runtime/node/fs_events.rs` at
`c6da4a4`) and changed one thing: `unregister_watcher` now queues the same rebuild, so
**closing** a watch also stops and restarts the stream. 1.3.13 only rebuilt on open.

Measured on a Mac Studio (macOS 27, Bun 1.3.13), creating a file as soon as `watchRoot`
resolved:

| Condition | Never reported |
|---|---|
| idle, previous watch closed long before | 0 / 15 |
| idle, previous watch closed just before | about 1 in 10 |
| another watched directory just had 1000 writes | 10 / 30 |
| `watch.slow.test.ts` dotfiles test, 24 busy loops, 8 parallel `bun test` runs | 19 / 200 runs |

Each event was dropped, not delayed: a lost one was still missing after 8 s. CPU load alone
barely widens the window. Busy file systems do, since the CF thread waits on `fseventsd`.

## Decision

On macOS, `watchRoot` resolves only after `nativeWatchesLive()`
(`apps/daemon/src/files/fsevents.ts`) has proven the stream live. The probe makes a fresh
directory under the temp directory, opens `fs.watch` on it and writes a file there (at 2 ms,
then doubling to 100 ms) until a write is reported. That watch was registered after the
caller's, and no older stream covers its new directory, so the stream that reports it covers
both. It gives up after 5 s and lets the caller go on, as before.

The probe leaves its watch open. The next probe closes it, then removes its directory, and
only then opens its own, so the rebuild that close queues is covered by the new probe too.
The last probe's watch is removed at exit.

- On Bun 1.4.3 a probe that closed its watch when done (the first version of this fix)
  rebuilt the stream just as `watchRoot` resolved, so the change the caller made next was
  lost: the regression test failed 39 of 40 runs under load.
- Callers arriving while a probe runs share the next probe, which starts after it; a probe
  that registered before a caller's watch proves nothing for it.
- Cost: one extra watched directory per Daemon, and about 10 ms per arm (p50), up to about
  50 ms with a busy file system. Timers exist only while a watch is being armed; an idle
  Daemon wakes for nothing.
- Elsewhere it resolves at once: Linux uses inotify (ADR 0047), whose watch is added
  synchronously.

`watchFile` (open file tabs) is unchanged: its first read takes longer than the stream needs
to start, and no test could show a write after that read being lost.

The regression test (`watch.slow.test.ts`, macOS only) arms 20 watches, each beside a watched
directory that just had 1000 writes. Without the probe every run loses 2 to 9 of them.

## Rejected

- A longer wait in the test: the change is lost, so no wait finds it.
- A fixed sleep after arming: how long the stream takes to start isn't bounded.
- One probe watch kept open for good, written to by every probe: it can be answered by the
  stream from before the caller's watch. With Bun 1.3.13 the regression test failed 9 of 40
  runs under load.
- Our own FSEvents stream through `bun:ffi`: FSEvents calls back on its own thread, and the
  paths it hands over are freed before a thread-safe `JSCallback` runs.

## Live watches rescan after each rebuild (ENG-370)

Every `fs.watch` opened, and on Bun 1.4 every one closed, anywhere in the Daemon rebuilds the
shared stream, so watches that are already live lose changes made during the rebuild too.
Measured on an M2 Max (Bun 1.4.4, heavy load): 3 to 5 of 60 changes on two live watches lost
per run while another watch opened or closed after a 1000-write burst.

So after each probe proves a rebuilt stream live, every live watch is told it may have missed
changes, as FSEvents' own `MustScanSubDirs` would (`onNativeWatchesRebuilt` in `fsevents.ts`):

- A directory watch (`files/watch.ts`: open file tabs, `git.watch`, directory interest) runs
  its settle recheck (ADR 0046).
- A `watchRoot` reports its own root, which its callers already treat as "look at everything".
- Opening or closing a directory watch, and closing a `watchRoot`, starts a probe
  (`nativeWatchesChanged`); opening a `watchRoot` already waits for one. With no live watch
  left, no probe runs.

The probe only proves the stream started after the caller's watch, so a change dropped by that
rebuild happened before the rescan runs, and the rescan finds it.

- Cost: one probe per open or close (about 10 ms, overlapping ones shared), then one stat per
  watched file and one spurious root change per `watchRoot`. Nothing runs while no watch opens
  or closes; an idle Daemon still wakes for nothing.
- A rescan is a hint, not an event: `git.watch` and directory-interest subscribers may see one
  extra notification when a tab opens or closes.
- Rejected: sharing watches per path to register less. It narrows the window but every new
  directory still rebuilds the stream.
- The real fix is upstream: Bun could start the new stream before stopping the old one, or keep
  one stream per watcher. The regression test is `files/fsevents.slow.test.ts` (macOS only).
