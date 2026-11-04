---
status: accepted
---

# pre-push on Windows tests what Windows can run

## Context

pre-push tests every changed package's fast tier (ADR 0096). On Windows that can't pass: the
Client's native Daemon installs and SSH shell fixtures, the Desktop App's Mac packaging, the
bench's `/proc` samplers, the relay's SIGTERM stop and the release tooling's Python signer are
POSIX-only, and CI runs them only on Linux and macOS. A change to a root file (`bun.lock`,
`package.json`) makes every package changed, so no such push from Windows could pass, and
`--no-verify` is not an option.

## Decision

**On Windows, pre-push skips the packages listed in `tooling/ci/windows-skipped-packages.txt`,
says so, and runs their Windows-safe files from `tooling/ci/windows-client-tests.txt` (the list
CI's Windows job runs). Every other changed package is tested whole, as on macOS and Linux.**

- The list names packages, each with why it is POSIX-only; a new package is tested on Windows
  until it is listed.
- A package's Windows failures that are bugs are fixed, not listed: the SDK's local transport
  and test Daemon on the named pipe, Git Bash output, `~` without HOME, paths in tests.

## Consequences

- A push from Windows can break a listed package's POSIX tests; CI catches it on Linux and macOS.
- CI's Windows job still runs only the Daemon and the listed Client files; the packages now
  green on Windows (mobile, SDK, Extensions, predict) are checked there by pre-push alone.
