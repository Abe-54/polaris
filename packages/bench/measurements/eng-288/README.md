# ENG-288: sqllens and bash-language-server memory

Measured 2026-11-09 on the Mac Studio (Mac14,13, M2 Max, 32 GB, macOS 27.0) with `src/languageServerMemory.ts`. Each run starts one server from the Host's managed installs, launched as `apps/daemon/src/languages/sql/launch.ts` launches it (private Node 24.18.0, the same environment and initialization options), and samples its process tree every 50 ms with the bench sampler (`src/sampler.ts`).

```sh
bun packages/bench/src/languageServerMemory.ts sql  --json packages/bench/measurements/eng-288/sqllens-400.json
bun packages/bench/src/languageServerMemory.ts bash --json packages/bench/measurements/eng-288/bash-400.json
# the same with --node-flags=--max-semi-space-size=1 → *-semispace1.json
```

Phases: `initialize` (initialize + initialized, 5 s), `open` (didOpen of a 400-line file, 5 s), `idle1` 60 s, `typing1` 60 s (an edit every 250 ms with full-text sync, a completion and a hover every second), `idle2` 60 s, `typing2` 60 s, `idle3` 60 s. One run each; the machine was a workstation with other work running, so treat differences under ~10% as noise. On a Pi 4 run the same commands: the script finds the installs under `$POLARIS_HOME/languages`.

Versions: sqllens-language-server 0.5.0 (sqllens 1.11.0, PostgreSQL dialect), bash-language-server 5.8.1 with ShellCheck 0.11.0 (Homebrew) and the managed shfmt 3.14.1.

## sqllens: a high startup cost, then a plateau

Physical footprint, median of each phase (MiB):

| Run | initialize | open | idle1 | typing1 (max) | idle2 | typing2 (max) | idle3 |
|---|---|---|---|---|---|---|---|
| default (`sqllens-400.json`) | 520 | 621 | 621 | 1166 (1274) | 1272 | 1270 (1276) | 1268 |
| `--max-semi-space-size=1` | 363 | 409 | 393 | 1172 (1198) | 1191 | 1194 (1209) | 1197 |

- **Startup, before any document:** ~520 MiB. `import "sqllens"` alone takes Node from 43 to 531 MiB RSS in 580 ms: sqllens statically imports the ANTLR lexers and parsers of all ten dialects (`token/tokenize.js`, `token/consumed-as.js`; ~40 MB of generated JS, TSqlParser.js alone 10 MB), although a server parses one. After a full GC the JS heap holds 133 MiB live (old space 108 MiB, large objects 20 MiB, 41 MiB external); V8 keeps the young generation grown to 128 MiB from the import burst, and the rest is compiled code and allocator pages outside the heap.
- **Steady state, not growth:** typing takes the one `node` process to ~1.2–1.3 GB, and the second typing burst does not raise it further. Idle windows after typing are flat at 0.00–0.01% CPU, and nothing is returned to the system: footprint stays at the plateau (RSS drops a little as pages are compressed).
- **All of it is the one `node` process** (the tree never has a second process).
- `--max-semi-space-size=1` trims ~160 MiB from startup only; the plateau is the same, and that run's last idle window showed 52% CPU, so the flag is not a fix on its own.

## bash-language-server: a parse spike on open, then ~90 MiB

| Run | initialize | open (max) | idle1 | typing1 (max) | idle2 | typing2 | idle3 |
|---|---|---|---|---|---|---|---|
| default (`bash-400.json`) | 42 | 607 (632) | 607 | 89 (287) | 90 | 89 | 91 |
| `--max-semi-space-size=1` | 34 | 427 (620) | 91 | 99 (100) | 99 | 107 | 107 |

- **The `node` process holds it, not ShellCheck.** Its RSS peaks at 646 MiB right after `didOpen` (tree-sitter-bash in WebAssembly parsing and analysing the document). Each ShellCheck child is ~43–45 MiB and lives for one lint (0.2–0.3 s of CPU), at most one at a time.
- **No growth:** after the open spike is collected (once typing starts) the footprint stays at ~90 MiB through both typing bursts. The ~660 MiB in the issue is this spike, held until the next GC: an idle server that never receives another edit keeps it (idle1 stays at 607 MiB).
- Idle windows with a pending lint show 0.6–1.2% CPU from ShellCheck runs debounced after the last edit.

## Proposed fixes (not built)

The runtime already starts a server on document demand and stops it 10 minutes after the last document closes in every Client, or earlier under Host process pressure (`apps/daemon/src/languages/runtime/README.md`, ADR 0033). So both costs land only while a SQL or shell file is open, and the sqllens plateau is held for as long as one stays open.

1. **Idle stop with documents open (sqllens first):** retire a server after a period with no requests or edits even while its documents stay open, and replay the open documents on the next request (the restart path already replays retained demand). This is the only fix found for the sqllens plateau, which the process never releases.
2. **sqllens, upstream:** load each dialect's grammar on first use (a dynamic `import()` per dialect in `token/tokenize.js` and `token/consumed-as.js`) so a server pays for one dialect, not ten. Raise it with sqllens upstream; we don't patch the package.
3. **bash-language-server:** the 600 MiB spike after `didOpen` stays until the next collection. A `--max-semi-space-size` launch flag lowers it to ~430 MiB, but its CPU cost (and the 52% idle CPU seen with sqllens) needs measuring first; the idle stop in 1 covers it too.
4. **Pi 4 pass:** rerun the four commands above on the Pi 4 Host and add the results here before choosing between 1 and 3.

## Files

- `sqllens-400.json`, `bash-400.json`: default runs.
- `sqllens-400-semispace1.json`, `bash-400-semispace1.json`: with `--max-semi-space-size=1`.
- Each phase lists the tree's RSS and footprint (median, max), CPU, wakeups and the per-process peak table (the per-process peaks are for the whole run so far, not the phase alone).
