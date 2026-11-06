# The Daemon gives memory back once it goes quiet after work

Two seconds after the last Turn in flight ends, or after a burst of file reads, with no Turn in flight, the Daemon runs one full collection and `Bun.shrink()` (`apps/daemon/src/memory/`). It never schedules this while idle: a Turn end, or a versioned file read once 4 MiB have been read since the last release, starts the timer, the next one restarts it, and one release follows each quiet spell.

## Why

- **`sessions.footprint_growth_mib` looked like a regression, but no merge caused it.** The baseline (recorded at `14e1072`, 48 MiB) and main at `53a2dba` measured the same on the same afternoon: medians of 65 and 67 MiB over five runs each, 56–71 and 57–74 MiB per run. The earlier baseline's own runs spread from 34 to 68 MiB.
- **It is allocator high-water, not retained objects.** After the phases, the Daemon's live JavaScript heap is about 19 MiB. `vmmap` shows the growth in JavaScriptCore's allocator (`WebKit Malloc`, 40 → 102 MiB dirty), and the peak footprint reaches 196 MiB. Waiting ten more seconds or a full collection alone gave back only 5–10 MiB. How high the heap peaks before the collector catches up depends on how busy the machine is, so the metric followed the load (2.6 busy cores when the baseline was recorded, 5–11 now).
- **A collection plus `Bun.shrink()` returns those pages.** With it, footprint growth is 19 MiB (from 60–67), and latency, throughput and peaks are unchanged, because it runs only after the work. `idle` is unchanged, since an idle Daemon never runs it. On a Pi 4, or on a Mac running for days, it's the steady state that stays resident.
- **File reads leave garbage that no collection may come for (ENG-766).** Opening or watching a file reads all of it into a fresh buffer. With no Turn to end and nothing allocating afterwards, those pages stayed or went on JavaScriptCore's timing: `editor.tabs20_daemon_rss_mib` sat at about 90 or 108 MiB on one commit (2 of 24 CI runners high), which flipped the bench gate when two of its three runners landed high. With a release after the burst it is 83.5–85.1 MiB on all 36 runners, 5 MiB under the old low mode, and a deliberate 30 MiB retained allocation still reads as +30 MiB and fails the gate.
- **Why 4 MiB read since the last release, not any large read.** The count stays under the 5 MiB the steady memory gate tolerates, so what a small read leaves behind can't flip it, and a watched 1 MiB file rewritten every few seconds releases once per four rewrites rather than each time.

## Consequences

- One full collection per quiet spell. `shrink` may also drop JavaScriptCore's compiled code, so the next Turn can recompile hot functions: a few milliseconds, once.
- `bun-types` marks `Bun.shrink` deprecated, with no replacement. If a Bun upgrade removes it, typecheck fails there; `Bun.gc(true)` alone is the fallback, though it gives back only 5–10 MiB of the ~45.
- Reads never wake an idle Daemon, since only a read starts the timer. `idle` on 24 CI runners per side: no-Client wakeups 25.5 vs 26.6/s (quartiles overlap; baseline 26.3), with a Client 36.05 vs 36.00/s, CPU unchanged. Right after a release wakeups run higher for some seconds: `editor.tabs20_wakeups_per_s` at `--quick` (5 s after the burst) goes from 32 to 41/s, while at full size (35 s after) it goes from 12.5 to 3.8/s and CPU from 0.10 to 0.03%, over 8 runners per side.
- Only `readVersioned` counts, so `files.read`'s larger transfers (blobs, images) still wait for a Turn end or JavaScriptCore.
- A Turn that ends while another runs doesn't release; a Daemon with a session always Working (a long agent) only releases between Turns.
