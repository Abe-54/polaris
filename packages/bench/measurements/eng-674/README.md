# ENG-674 forwarding measurements

These native benchmark receipts accompany [BENCH.md](./BENCH.md).
They do not replace a committed baseline. `before-traces` uses the assigned
base in a detached worktree with dependency symlinks (`gitDirty: true`); `forwarding-unconfigured` and `forwarding-down` use the P1 implementation.
`forwarding-eight-experiment` temporarily changed only the default queue count
to eight, then restored it. `forwarding-profile` includes heap snapshots and
profiler overhead and is diagnostic only. `before-idle` is the initial run before
receiver/runtime integration; `after-idle` is the validated P1 implementation.

The unprofiled trace comparisons fail RSS gates; both idle comparisons pass.
See BENCH.md for conditions, ranges, failure disclosure and ENG-682. Raw heap
contents and CPU profiles remain outside these receipts; only aggregate heap
counts are included.
