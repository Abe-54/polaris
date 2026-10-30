# @polaris/bench

Benchmarks for the Daemon: memory, CPU and latency, measured on the real `polaris serve` driven through `@polaris/client` exactly as a Client drives it. Performance is a product requirement (PRODUCT.md): the Daemon has to stay light on a Raspberry Pi 4 and a small Linux VM as well as on a Mac, and the Desktop App has budgets of its own (< 1 GB in a heavy session, ≥ 120 Hz, Workspace switch < 100 ms). This package is where those numbers are measured and guarded.

```sh
bun run bench                       # every scenario, full sizes, one run
bun run bench sessions idle         # just these
bun run bench --quick               # small sizes (what CI runs)
bun run bench --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c.json
bun run bench --list
```

Each scenario run gets a **fresh Daemon** with a throwaway `POLARIS_HOME` (under `/tmp/polaris-bench/`), started from source (`bun apps/daemon/src/main.ts serve --foreground`) or, with `--binary`, a compiled build from `scripts/build-daemon.ts`. Clients connect through `polaris bridge` (what `ssh <host> polaris bridge` runs), or with `--transport socket` straight to the Unix socket. The Daemon is stopped and its home removed afterwards.

## Options

| Option | What |
|---|---|
| `[scenario...]` | Scenarios to run (default: all), see below. |
| `--quick` | Smaller sizes: seconds instead of minutes. CI runs this. |
| `--runs N` | Run each scenario N times (fresh Daemons every time); every metric reports the median, with the min–max range. |
| `--json PATH` | Also write the result JSON to PATH. |
| `--compare PATH` | Compare with a baseline JSON; exits 1 on a regression beyond tolerance. |
| `--fail-on GATES` | What gates `--compare` (default all kinds): kinds from `memory,cpu,latency,time,throughput,count`, single metrics as `scenario.metric` (e.g. `cold-start.startup_modules`), or `none`; `-scenario.metric` drops one metric from the gate. |
| `--gate-same-machine` | Narrow the gates when the baseline is from another machine: memory, counts and named metrics gate only on the baseline's OS, arch and core count; CPU, latency, time and throughput only on its CPU model. The rest is compared and reported without failing (CI). |
| `--save-baseline` | Write the result to `baselines/<machine>[-quick].json`. |
| `--markdown PATH` | Append a Markdown summary (e.g. `$GITHUB_STEP_SUMMARY`). |
| `--profile` | CPU profile and heap snapshot for each scenario run (below). |
| `--binary PATH` | Bench a compiled `polaris` instead of the source. |
| `--transport bridge\|socket` | How Clients connect (default `bridge`). |

Relative paths are resolved against the repository root. Every invocation also writes `packages/bench/results/<timestamp>/` (git-ignored): `result.json`, `summary.txt`, `comparison.txt` and any profiles.

## Scenarios

Sizes are full / `--quick`.

| Scenario | What it does | Key metrics |
|---|---|---|
| `cold-start` | Spawns the Daemon 5 / 3 times; polls `hello` on the socket every 2 ms. | `hello_ms` (spawn → first successful hello), `rss_settled_mib` and `footprint_settled_mib` 2 s later, `startup_modules` (modules loaded by the time the Daemon listens, from `POLARIS_DEBUG_MODULES`; held to 3% or 5 modules, since it has no noise; not reported for a compiled binary), `bridge_connect_ms` (spawn `polaris bridge` → hello). |
| `idle` | 3 Workspaces (git repos), 6 Agent Sessions that ran a Turn and went Dormant across a Daemon restart. 30 s / 10 s with one Client subscribed, then the same with none, beside a bare Bun process as the floor. | CPU % (100 = one core), wakeups/s, RSS. Notes flag CPU or wakeups above the bare-Bun floor. |
| `prediction-context` | Authenticated context RPC before Trust, local imported signatures, warm requests and imported-file edit invalidation, followed by an idle window. No language server or model server. | Cold and warm p50/p95 latency, piece count, idle CPU and RSS. |
| `sessions` | Concurrent Agent Sessions on the scripted Harness: phases `m10`, `m50`, `m50c4` (C = Clients, all subscribed to every session) / `m5`, `m10c3`, then `burst` and `repeat`. Realistic Turns: 10 items, 6 of them streaming 20 deltas at 50/s, one approval. | `dispatch_ack`, `dispatch_to_event` (SendTurn → its `TurnStarted` at the Client), `delta_latency` (Harness emit → Client receive, from the timestamp in each delta), `event_latency` (commit → Client, 1 ms resolution), `approval_round_trip`, CPU, peak RSS; `burst.deltas_per_s` (one session streaming without pause: the pipeline's ceiling); `rss_growth_mib` and `footprint_growth_mib` (after the phases and burst, over `rss_before_mib`; both are sampled after the Daemon's quiet release, `before` behind a one-session warm-up Turn) and `rss_growth_repeat_mib` (the biggest phase again: a leak steps up twice). |
| `history` | Seeds 20 sessions × 50 Turns × 96 items / 5 × 20 × 46 (~100k / 5k events) through the Daemon, then restarts onto the store. | `seed_events_per_s` (commit throughput), `restart_hello_ms`, `loaded_rss_mib` (the read model keeps every Turn in memory), `host_snapshot_ms`, `session_snapshot_full_ms` / `_last10_ms`, `host_resume_10k_ms`, `session_resume_half_ms`, snapshot sizes. |
| `blobs` | 100 / 16 MiB of incompressible bytes: `files.read` (Daemon → Client) and `attachments.stage` (Client → Daemon). RSS sampled every 50 ms. | MB/s each way, peak RSS over the pre-transfer level, RSS retained after. |
| `byte-streams` | 100 / 16 MiB from a loopback server over one Host-address byte stream (ENG-613) while the Client times a `roundTrip` every 20 ms: credit flow control must keep RPC fast next to a big transfer. | `transfer_mb_per_s`, `rpc_quiet_p99_ms`, `rpc_during_p50/p99/max_ms`, `rss_peak_over_base_mib`. |
| `host-address-reload` | A Vite-sized page reload through Host addresses (ENG-612): 1200 / 300 modules of 1.5–30 KB from a loopback HTTP server, one byte stream each, six at a time as Chromium does per host, while the Client times a `roundTrip` every 20 ms. One stream per module is the worst case for stream setup. | `reload_ms`, `stream_open_p50/p99_ms`, `rpc_quiet_p99_ms`, `rpc_during_p50/p99/max_ms`, `rss_peak_over_base_mib`. |
| `files` | A generated, committed repo of 50k / 5k files (~1.5 KB each, cached in `/tmp/polaris-bench/fixtures/`). Path search and grep, first with fff and then with the git fallback (`POLARIS_FFF=off`), each in its own Daemon. | `first_search_ms` (builds the index), `search_p50/p95_ms`, `grep_p50/p95_ms`, `index_rss_mib`. |
| `git` | A private copy of the same tree; 5 / 3 scripted Turns each rewriting 20 files, so the engine captures real checkpoints. | `checkpoint_before_ms` (SendTurn → `CheckpointRecorded(before)`), `checkpoint_after_ms` (last item → `CheckpointRecorded(after)`), `turn_diff_ms`, `status_ms`, `working_tree_diff_ms`, `status_ignored_ms` (`git.status` with `ignored`, as the explorer asks, after adding an ignored `node_modules` of 5,000 / 500 files). |
| `terminal` | A `Bun.Terminal` running `yes … \| head -c 50M` / `10M`, attached through `attachTerminal` (raw bytes on the blob channel when the Daemon has `terminal.binary`). On macOS most of the CPU is the PTY itself: Bun reads it ~66 bytes at a time, ~36 ms of CPU per MB before the Daemon does anything. | `mb_per_s`, CPU, peak RSS over base. |
| `rules` | The Rules layer (`apps/daemon/src/rules/`) on a change to a generated 5k-file tree: 1,000 / 200 files each given 40 added lines, every 50th with an `eval`. Each mode runs `apps/daemon/scripts/rules-run.ts` in its own process, sampled as a tree (Betterleaks and `polaris rules-scan` included); no Daemon, since nothing runs the Rules over RPC yet and they add nothing to an idle one. | `history_ms` / `snapshot_ms` (pull request vs Turns), `*_peak_rss_mib` (whole tree), `*_cpu_avg_pct`, `*_findings`. |
| `desktop-idle` | The built Desktop App (`bun run --cwd apps/desktop build`; skipped when not built or not on macOS) against a fresh Daemon: waits for its `polaris: ready` line (window painted, local Host connected), settles 10 s / 3 s, samples the Electron process tree 10 s / 3 s. The window is shown; `POLARIS_BENCH_DESKTOP_HIDDEN=1` hides it. | `footprint_mib` (M1 budget: < 1 GB for the whole app), `cpu_idle_pct`, `rss_mib`, `processes`, `ready_ms`; a per-process peak table in the notes. |
| `review` | Review on Pierre Diffs (ENG-218, ENG-230): the built Desktop App (skipped when not built or not on macOS) against a fresh Daemon runs `apps/desktop/scripts/reviewBench.ts`, which commits generated changes with `git fast-import` and opens each as a Review Checkout would serve it (`#review/bench`, real `git.diff` over IPC), one fresh app per scene: `full` 2,000 / 300 files expanded, `collapsed` 5,000 / 2,100 (past the 2,000-file threshold), `list-only` 12,000 / 10,100 (past 10,000), `huge` one 100k / 20k-line file. Scrolls 600 frames at 240 px. | `<scene>_first_file_ms`, `_parsed_ms`, `_frame_p95_ms` (budget: 1.5 display intervals, ≤ 2% dropped), `_app_mib` (budget: < 1 GB with the Review open), `_app_scrolled_mib` (after scrolling, GC forced; info), `_daemon_peak_rss_mib` while it diffs. |
| `usage` | Synthetic Claude Code transcripts and Codex rollouts, 1.1 GB / 89 MB (cached in `/tmp/polaris-bench/fixtures/`), given to the Daemon through `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. The first `usage.query` starts building the Usage index in the background, timed to `usage.watch`'s end marker; a second query finds nothing new; then 100 responses are appended to a live transcript (timed until a query shows them). | `build_ms`, `build_mb_per_s`, `build_rss_peak_over_base_mib` (and footprint), `noop_refresh_ms`, `append_refresh_ms`, `rss_settled_mib`, `index_mib`. |
| `usage-contention` | The same kind of logs at 2.7 GB / 1.1 GB. One Client streams a scripted session and times a `files.stat` every 50 ms, then opens `usage.watch` and `usage.query` on the same connection, as the Usage view does. | `first_query_ms`, `first_pass_ms`, `rpc_during_p50/p99/max_ms`, `delta_latency_during_p99/max_ms` (while the first pass runs), `rpc_quiet_p99_ms` before it. |

Scenarios are independent and each starts its own Daemons, so any subset can run alone.

## The scripted Harness

`POLARIS_BENCH_HARNESS=1` makes `HarnessRegistryLive` (`apps/daemon/src/harness/registry.ts`) register `apps/daemon/src/harness/bench/BenchDriver.ts` for Codex and Claude (`bench/kinds.ts`) instead of their real drivers. Every other Harness (OpenCode, Gemini CLI, Copilot CLI) keeps its real driver and its probed availability. It spends no tokens and starts no vendor process, but its events go through the real engine, store, streams and transport. A prompt `bench:{json}` sets the Turn's script (`TurnScript` in `src/drive.ts` mirrors it):

| Field | Default | What |
|---|---|---|
| `items` | 5 | Completed items per Turn; kinds rotate message, reasoning, command, tool call, file change. |
| `deltasPerItem` | 10 | Deltas streamed before each message, reasoning and command item. |
| `deltaBytes` | 64 | Bytes per delta. Each starts with `@<epoch ms>\|`, its emit time. |
| `deltaIntervalMs` | 5 | Pause between deltas; 0 = as fast as the engine takes them. |
| `approvalEvery` | 0 | Every Nth item first asks for an approval and waits for a Client's answer. |
| `touchFiles` | 0 | Files written under `<cwd>/polaris-bench/` during the Turn (for checkpoints and diffs). |
| `itemBytes` | 0 | Minimum text size of each completed text item. |
| `startDelayMs` | 0 | Pause before `TurnStarted`. |
| `subagents` | 0 | Foreground Subagents after the items, each started by an Agent call that completes with its streamed report (`bench/subagent.ts`). |

`create a test constellation` is a deterministic instruction-delivery probe on the scripted Harness. It selects the attached `plan` tool named by the Polaris preamble, calls it with the injected Workspace ID, and emits that tool call without reading or writing the repository. It tests delivery and execution, not live Model comprehension. Run `bun test apps/daemon/src/mcp/tools/bootstrap.test.ts`.

## The sampler (reusable)

`src/sampler.ts` samples a **process tree**: the roots you give it and all their descendants (for the Daemon: Harness processes, git, terminals), at a fixed interval, and reports min / median / p95 / max of RSS and footprint, per-interval CPU %, average CPU, CPU seconds, wakeups/s and a per-process peak table. It is exported (`@polaris/bench/sampler`) so the Desktop App can reuse it with the Electron main process as the root (renderers and helpers are its children).

`src/proc.ts` reads the counters without spawning anything:

- **macOS**: `proc_pid_rusage(RUSAGE_INFO_V2)` via `bun:ffi` gives RSS, **physical footprint** (what Activity Monitor shows as Memory: compressed and swapped pages included, shared file-backed pages excluded), user + system CPU (mach time converted with `mach_timebase_info`), idle + interrupt **wakeups**, and CPU of reaped children. `proc_listchildpids` walks the tree.
- **Linux**: `/proc/<pid>/stat` (CPU in clock ticks at `USER_HZ` = 100, reaped children included), `/proc/<pid>/status` (VmRSS; footprint = RssAnon + RssShmem) and the voluntary + involuntary **context switches** of all threads as the wakeup count. Children from `/proc/<pid>/task/*/children`.
- Fallback (or `POLARIS_BENCH_PS=1`): `ps` for RSS and CPU only (10 ms CPU resolution on macOS, whole seconds on Linux).

CPU is the change of user + system time over the tree between samples (including children that exited and were reaped in between) divided by wall time: 100% = one core. Prefer footprint over RSS when judging memory on macOS: RSS counts shared libraries and pages the allocator keeps but the system can reclaim.

## Results and baselines

A result is JSON: `env` (machine model, CPU, cores, RAM, OS, Bun version, git sha and dirty flag, source vs compiled, transport, sampler backend, date, and `backgroundCores`: how many cores other work kept busy in the second before the scenarios started), `options`, and per scenario its metrics (`value` is the median over runs, with `runs`, `min`, `max`, `unit`, `kind`, `better`), notes and duration.

Baselines live in `baselines/`, named by machine slug (`<model>-<cpu>-<cores>c`, plus `-quick`):

- `mac14-13-apple-m2-max-12c.json`: the lead's Mac Studio (M2 Max, 32 GB), full suite, median of 3 runs, source Daemon, bridge transport.
- `mac14-13-apple-m2-max-12c-quick.json`: the same at `--quick` sizes, for fast before/after checks.

Other apps were running on the machine while these were recorded (it is a workstation, not a lab), so treat single-digit-percent differences as noise; the tolerances below account for it.

**Check the machine is quiet before blaming the code.** Other load moves CPU-bound scenarios far beyond the tolerances: four stray `nice yes > /dev/null` processes on the Mac Studio took `terminal` from ~24 to ~6.5 MB/s on every commit alike. The bench warns when more than 2 cores are busy before it starts (`BUSY_BACKGROUND_CORES`), and `--compare` warns when either side was recorded that way. Before bisecting a regression, re-run the baseline's own commit: if it is slow too, the machine changed, not the code.

**Updating a baseline** (after an intended change, or on a new machine): close heavy apps, plug in, then

```sh
bun run bench --runs 3 --save-baseline                # full; writes baselines/<machine>.json
bun run bench --quick --runs 3 --save-baseline        # writes baselines/<machine>-quick.json
```

and commit it with a message saying why the numbers moved. Never regenerate a baseline to make a regression disappear: fix it, or explain it in the commit.

**CI** (`.github/workflows/ci.yml`, job `bench`): `--quick` on `ubuntu-latest`, summary in the job's step summary, result JSON uploaded as the `bench-result` artifact. It gates against `baselines/ci-ubuntu-latest-quick.json` with `--fail-on memory,cold-start.startup_modules,-git.rss_peak_mib,-blobs.upload_rss_peak_over_base_mib --gate-same-machine`: **memory** and the **start-up module count**, less the git and upload RSS peaks (single-sample maxima that doubled run to run across 26 CI runs), on any runner with the baseline's OS, arch and core count. Latency, time, throughput and CPU never gate in CI, shared runners being too noisy.

- **Memory doesn't depend on the CPU model; timings do.** GitHub hands the 4-core `ubuntu-latest` runners out on AMD EPYC 7763, 9V74 and 9V45 and on Intel Xeon. Across 26 runs on 2026-10-13, steady memory agreed within a few MiB on all of them (sessions `rss_before_mib` 112.9–118.1, cold-start `rss_settled_mib` 110.6–115.5), while `burst.deltas_per_s` ranged from 37k (EPYC 7763) to 78k (EPYC 9V45). So memory gates on OS + arch + core count, and timings would gate only on the same CPU model.
- **Why the core count.** The earlier baseline was keyed to the CPU model of a 2-core runner; once the runners became 4-core, no run matched it and `--gate-same-machine` never gated anything. A different core count still disables the gate (memory was only shown to agree within one runner shape), and the job's log says `not gating memory, …` with both machines' classes; refresh the baseline when that happens.
- **The module count has no noise.** Each Polaris or dependency module the Daemon imports at start costs about 0.1 MiB, and the count is the same on every run of a commit. A feature that adds a dozen eager imports fails it: load the feature on first use (see `apps/daemon/src/transport/lazy*.ts`), or explain the growth and refresh the baseline.
- **Refreshing it** (after an intended change, or a new runner shape): download the `bench-result` artifacts of a few recent `main` runs, any CPU model, and merge them; each metric becomes its median:

  ```sh
  gh run list --workflow ci.yml --branch main --limit 5 --json databaseId -q '.[].databaseId'
  gh run download <id> -n bench-result -D /tmp/bench-ci/<id>     # for each id
  bun packages/bench/src/merge.ts packages/bench/baselines/ci-ubuntu-latest-quick.json /tmp/bench-ci/*/bench-result.json
  ```

  `merge.ts` refuses results from different OS, arch or core counts, and names the merged baseline for the CPUs it spans (`linux-x64-4c-mixed`), so its timings gate no CPU model. Commit it with a message saying why the numbers moved. Never refresh it to make a regression disappear.

## Comparing and tolerances

`--compare baseline.json` prints every metric with its change and status, warns when the machine, sizes (`--quick`), Daemon build or transport differ, and exits 1 when a gating metric is worse than the baseline by more than `max(relative × baseline, absolute)`:

| Kind | Relative | Absolute | Why |
|---|---|---|---|
| memory, steady state (MiB) | 10% | 5 MiB | Settled, idle and loaded RSS / footprint repeat within ~3% run to run; this catches a real step (a leak, a new cache) without flagging allocator jitter. |
| memory at a peak, grown, or left after activity (`peakMemory`) | 25% | 10 MiB | Depends on when the GC ran: 15–30% spread between runs of the same build. |
| memory in `blobs` | 35% | ¼ of the payload | Transfers allocate in proportion to the payload and their peaks move with GC timing. |
| cpu (% of a core) | 50% | 2 points | CPU under load spreads ~10–20% between runs, light-load CPU much more. |
| latency (ms) | 50% | 5 ms | p50s of a few ms and p99 tails swing by several ms; the absolute floor keeps them from flapping. |
| time (ms) | 35% | 5 ms | Whole operations (start-up, snapshots, checkpoints, first search) repeat within a few %. |
| throughput (/s) | 30% (50% in `blobs`) | 0 | A drop of a third is a real slowdown; blob transfers are noisier. |
| count | 25% | 1 | Sizes and counts that should not change much. |

A metric can override its tolerance (idle CPU, for example, is held to 0.3 points over a bare Bun process), and informational metrics (`info`) never gate. The numbers come from the spread of the three runs behind the Mac Studio baseline (the `range` column of a `--runs 3` table shows it for any machine). If a metric flaps, loosen that metric's tolerance in its scenario with a comment saying why; do not loosen the defaults.

## Profiles and snapshots

`--profile` adds, per scenario run, into `results/<timestamp>/<scenario>-run<N>/`:

- **CPU profile** of the Daemon: `bun --cpu-prof --cpu-prof-md` (for a compiled binary, the same flags through `BUN_OPTIONS`), written when the Daemon exits: a `.cpuprofile` (Chrome DevTools → Performance, or speedscope) and a grep-friendly `.md`.
- **Heap snapshot** at the scenario's peak (after its measurements, so the snapshot's own allocation does not skew them): `heap-<label>.heapsnapshot`, V8 format, open in Chrome DevTools → Memory.

Profiled numbers include the profiler's overhead; `--compare` warns about it.

The hooks live in the Daemon, off by default (`apps/daemon/src/debug.ts`):

- `POLARIS_DEBUG_DIR=<dir>`: `SIGUSR1` runs a full GC and writes a heap snapshot into `<dir>` (SIGUSR2 is taken by upgrades).
- `POLARIS_DEBUG_STATS_MS=<ms>`: one JSON line on stderr every `<ms>` with `process.memoryUsage()` and the event-loop lag, for watching a live Daemon.
- `POLARIS_DEBUG_MODULES=1`: once listening, one JSON line on stderr with how many modules start-up loaded (`cold-start` reads it).

## Adding a scenario

Add `src/scenarios/<name>.ts` exporting a `Scenario` and list it in `src/scenarios/index.ts`. Use `ctx.launch()` for Daemons and `ctx.sample()` for samplers (both cleaned up for you), `src/drive.ts` to dispatch and watch sessions, and the metric constructors in `src/types.ts` (`memory`, `cpu`, `latency`, `time`, `throughput`, `count`) so comparisons know the kind. Keep `--quick` sizes to seconds.

## Known gaps

- The sampler measures the Daemon only; the `polaris bridge` processes (and ssh) are Client-side and not included.
- Wakeups are not comparable across platforms: macOS counts idle and interrupt wakeups, Linux counts context switches.
- The managed model server (`apps/daemon/src/prediction/managed/`) adds nothing to `idle`: its only timer is the 15-minute idle unload, armed only while a llama-server it started is running and unref'd, and its health poll runs only while the server is `Starting`. An idle Daemon with no server has neither.
- Auto-archive (`apps/daemon/src/engine/autoArchive.ts`) wakes an idle Daemon once an hour: one scan of the in-memory sessions, no I/O unless a Dormant session is due. It also sweeps on start, before any idle window, and when its setting changes.
- Idle compaction (`apps/daemon/src/engine/idleCompaction.ts`) adds nothing to `idle`: one sleeping fiber per session that is due a compaction (Idle or Dormant within the prompt cache's hour of its last Turn, above the threshold, on a Harness that compacts), woken once at 55 minutes, and a store subscriber that only reacts to a few session events. The idle scenario's Dormant bench sessions arm none (3 runs on the Mac Studio: `noclient_wakeups_per_s` 0.664 vs the baseline's 0.767, `noclient_cpu_over_bare_pct` 0.024 within its 0.3-point tolerance).
- The Lead's slot-stall wake (`apps/daemon/src/constellation/stall.ts`, `nextSlotStall`) adds nothing to `idle`: it is one timer per Constellation, armed only while a local worker holds a `__workers` slot with no first Turn, for when `workerPhase` would read it stalled, and cleared once the Turn starts or the Lead has heard. A Daemon with no working Constellation never arms it (A/B on the Mac Studio, 3 runs each: `noclient_cpu_over_bare_pct` 0.269 before and after, wakeups 8.83 vs 8.80/s).
- History is seeded through the Daemon, so full sizes take a while (commit throughput is itself a metric); a much larger store (1M events) would need a direct SQLite seeder.
- No Desktop App scenarios yet (there is no Desktop App); the sampler is ready for them.


## Editor (M3)

`bun run bench editor --runs 3` measures a 1 MiB versioned text open and save over the local socket and a loopback bridge standing in for a remote Host, then 20 per-file subscriptions at idle. It records Daemon memory, CPU, wakeups and changes alongside an unwatched window on the same connected Client and Host feed. Full runs settle for 35 seconds before each window to let Bun runtime activity cool down; quick runs use 5 seconds. Actual SSH/network latency, renderer typing latency and whole-app tab memory require separate Desktop App verification; bridge results are not measurements of a real remote Host.
