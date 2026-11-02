# terminal/

The `Terminals` service and the `terminal.open/attach/attachBinary/input/resize/close` handlers, built on `Bun.Terminal` (never node-pty).

## Design

- `open` runs `Bun.spawn(argv, { terminal: { cols, rows, data } })` in `cwd`, with `TERM=xterm-256color`. With no `argv`, it runs the Host user's login shell (the passwd entry, else `$SHELL`, else `/bin/sh`) with `-l`. A missing `cwd` is a `FileError`. `argv[0]` starts by its absolute path (`programIn`): a bare name is found on the child's own `PATH`, never in `cwd`, which Windows would search first (ADR 0070); a relative path is `cwd`'s. A command found nowhere is a `FileError` too.
- **On macOS the command is gated** (ADR 0052): it starts behind `/bin/sh -c 'read -r _ <&3; exec "$0" "$@"'` and runs only once `Bun.spawn` has returned. A command that exited before Bun watched it could deadlock the Daemon's event loop (Bun's blocking `wait4` against XNU waiting for the PTY to drain). The command is resolved before the gate, so a missing one stays a `FileError`.
- **The Daemon owns terminals**: they outlive Client disconnects. Any number of Clients can attach. Each terminal keeps a **256 KiB scrollback** ring (`SCROLLBACK_BYTES`), which is replayed first to every attacher. The replay and the live subscription happen synchronously, so no output is lost or duplicated between them.
- **Output is gathered** before it goes out: PTY reads are small (often ≤ 1 KiB) and each chunk sent on its own costs far more than its bytes. Output collects for up to `OUTPUT_FLUSH_MS` (4 ms, under a 120 Hz frame) or `OUTPUT_FLUSH_BYTES` (64 KiB), then reaches the scrollback and every attacher as one chunk. Exit, close and the upgrade hand-off flush first.
- **Two ways to attach.** `terminal.attach` sends each chunk base64 in JSON (every Client). `terminal.attachBinary` (capability `terminal.binary`) sends the output as one long-lived blob on the Wire's side channel, raw bytes, then `Exit`; the blob is stream-sourced, so a slow Client backpressures it (4 chunks in flight). `attachTerminal` in `@polaris/client` picks one from the Daemon's capabilities and gives the same items either way; it handles `Exit` only after the blob has ended, since JSON frames can overtake blob chunks.
- When the process exits, `Exit { code }` is sent (after 200 ms for the PTY to drain) and attach streams end. A signal gives `code: null`. An exited terminal still replays its scrollback and `Exit` until it is closed.
- `close` sends SIGHUP (as closing a terminal window does), closes the PTY, sends `Exit { code: null }`, and forgets the terminal. Closing the layer's scope (Daemon shutdown) closes every terminal.
- **On Windows** (ConPTY, docs/adr/0061-windows-process-trees.md): the default shell is `pwsh`, else `powershell`, else `ComSpec` (`shell.ts`), with `-NoLogo`; the spawn gets three stdio entries (ConPTY refuses more); there is no PTY fd to note or hand over (upgrades are off there). `close` runs `taskkill /T /F` on the shell before closing the console, since closing it leaves the shell's children running; Daemon shutdown does the same synchronously.
- **Handlers**: `TerminalRpcsLive` is a partial `DaemonRpcs` handler layer. It needs `Terminals`: `TerminalsDaemonLive` in `polaris serve` (recorded under `~/.polaris/`, handed across upgrades), `TerminalsLive` (in memory only) in tests. It also needs `EventStore`: a terminal whose cwd is inside a Review Checkout starts with `repositoryEnv` (`environment.ts`, docs/adr/0054-repository-code-gets-an-allowlisted-environment.md).
- The login shell (`shell.ts`) comes from `userInfo().shell`, then `/etc/passwd`, then `$SHELL`, then `/bin/sh`. Bun reports `"unknown"` for the passwd shell in some containers (seen in Alpine and Debian), which is why the passwd file is read directly.

## Across Daemon restarts

| Event | Terminals |
|---|---|
| **execve upgrade** (`polaris upgrade`) | **Keep running.** Same terminal ids, same shells (with their variables and jobs), scrollback replayed, input, resize and the exit code all work afterwards. |
| **crash, `systemctl`/`launchctl` restart, reboot** | **End.** The PTY master closes with the process, so each shell gets SIGHUP. The next Daemon lists them as ended (`exit: { code: null }`, `endedBy: "daemon-restart"`, with their `cwd` and `argv`); a Client that re-attaches gets the `Exit { code: null }` rather than NotFound, and can offer to open a new terminal in the same `cwd`. |

How the upgrade hand-off works (verified by `handoff.slow.test.ts` on macOS arm64, Debian arm64 (glibc) and Alpine arm64 (musl)):

1. `open` notes the PTY **master fd** that `Bun.Terminal` opened: the lowest fd that was not open before the spawn and has a slave device (`ptsname`). Bun keeps a few dups of it; one is enough. `Bun.Terminal` does not expose its fd, hence the scan (1024 `fcntl` probes, synchronous with the spawn).
2. The terminals register a `HandoffContributor` (`service/upgrade.ts`): at upgrade time they hand over `terminal:<id>` → master fd and shell pid (the shell stays our child: same PID), and write `~/.polaris/terminals-handoff.json` (ids, cwd, argv, size, slave device, exit states, base64 scrollback).
3. The new image finds `terminal:<id>` in the hand-off and **adopts** the fd: reads with `Bun.file(fd).stream()` (the fd is non-blocking; Bun's reader waits for readiness, while `fs.createReadStream` and `tty.ReadStream` fail with EAGAIN), writes with `writeSync` plus a retry queue on EAGAIN, and resizes with `stty -f/-F <slave> cols C rows R` (`ioctl(TIOCSWINSZ)` is variadic, which bun:ffi can't call correctly on Apple arm64). Bun doesn't know the adopted shell, so it is reaped with `waitpid` every 200 ms to get its exit code.

Output read by the old image after the hand-off file is written (a few ms before the exec) is lost from the scrollback; Clients were disconnected by the exec anyway and see everything after it.

## Known gaps / TODOs

- Each attacher's queue is unbounded, so a stalled Client buffers output in the Daemon until it detaches (for `attachBinary` too: the blob pulls from that queue).
- `terminal.input` is still base64 in JSON: keystrokes are tiny and pastes are one message, so it isn't worth a binary path yet.
- Exited terminals stay until `close`. There is no TTL yet.
- Terminals are not tied to a Workspace id. `open` takes only a `cwd`, as the protocol does.
- Terminals don't survive a crash or a service restart (see above). A shell that ignores SIGHUP is left running, orphaned; nothing kills it.
- Terminals ended by a restart stay listed until `close`.
