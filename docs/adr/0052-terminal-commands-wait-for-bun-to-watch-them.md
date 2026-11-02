---
status: accepted
fixes: a terminal whose command exits at once could freeze the Daemon on macOS
---

# Terminal commands wait for Bun to watch them (macOS)

## Context

CI (macos-15, run 38751529181 attempt 1) stalled for 300 s in
`Terminals.slow.test.ts`, at "attaching after exit replays the output and the
Exit", whose command is `sh -c "echo done-now; exit 0"`. Bun's own 5 s test
timeout never fired, so the JavaScript thread itself was blocked.

Reproduced on macOS 27 with Bun 1.3.13: opening terminals whose command
prints and exits at once, 32 at a time, under CPU load freezes the process
within a few dozen opens. `sample` shows the main thread in `wait4`, and the
child is a `(bash)` stuck in state `E` (exiting). The chain:

1. Bun spawns a PTY child with `setsid` + `TIOCSCTTY`, so the child is a
   session leader with the PTY as its controlling terminal.
2. The command writes output and exits before Bun registers its kqueue
   `EVFILT_PROC` watch (a short window, easily lost under load).
3. XNU's `proc_exit` makes an exiting session leader wait for its terminal's
   output to drain (`ttywait`, no timeout) before it becomes a zombie.
4. Bun's watch registration fails with `ESRCH` (the process is exiting), and
   on macOS Bun falls back to a **blocking** `wait4(pid, 0)`
   (`process.zig`, `onWaitPid`), on the event-loop thread.
5. Only that thread reads the PTY master, so the output never drains and
   neither side ever returns.

Linux is not affected: an exiting session leader there does not wait for its
terminal to drain, and Bun waits on Linux through pidfds.

## Decision

On macOS `Terminals.open` runs the command behind a gate:
`/bin/sh -c 'read -r _ <&3; exec 3<&-; exec "$0" "$@"' <argv…>`, with fd 3 a
pipe from Bun. Once `Bun.spawn` has returned, Bun watches the process, and
`open` writes a newline to fd 3; the shell then closes fd 3 and `exec`s the
command in the same PID. The command cannot exit before the watch exists, so
its exit is seen through kqueue while the event loop is free to drain the PTY.

- `open` must only **write** to the gate fd, never close it: Bun owns it and
  closes it later, and closing it twice could close an unrelated fd that took
  its number.
- A missing command used to fail `Bun.spawn` with ENOENT; behind the gate it
  would only fail inside the terminal. `open` checks it with `Bun.which` first
  so it stays a `FileError`.
- The gate costs one `/bin/sh` start per terminal on macOS. Linux spawns the
  command directly.

The regression test (`Terminals.slow.test.ts`, macOS only) runs 200 such opens in
a child process under CPU load with a deadline: it fails on every run without
the gate. The fix belongs upstream in Bun (a non-blocking wait or a drain
timeout); drop the gate once Bun has one.
