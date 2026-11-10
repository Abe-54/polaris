---
status: accepted
amends: ADR 0104
---

# One relay, in Rust

## Context

ADR 0104 left the Polaris Relay in two builds held to one contract: Bun + Effect in
`apps/relay` and Rust in `apps/relay-rs`. Railway has run the Rust build since ENG-862. The Bun
build served nobody and still cost a second implementation of every change, a conformance
mode in the tests (`POLARIS_RELAY_COMMAND`), and a name, `relay-rs`, that said the relay was
somewhere else (ENG-870).

## Decision

**The relay is the Rust one, and it lives in `apps/relay`. The Bun build is removed.**

- **`apps/relay` is a Cargo workspace and a Bun package at once.** The relay's crate is at its
  root (`src/`, `tests/`), the load generator in `bench/`. `@polaris/relay` is now only the
  contract suite (`contract/`), in TypeScript because it speaks to the relay with the
  protocol package's own party code, as the Daemon and the Mobile App do.
- **Every test that needs a relay starts the release binary.** The contract suite, the
  Daemon's Linked Device tests and the Mobile App's relay tests get its path from
  `@polaris/relay/testing/binary`, which runs `cargo build` on first use. `POLARIS_RELAY_BIN`
  names a binary built elsewhere.
- **Tests of the Bun build's internals went with it.** The Rust units cover the same
  behaviour (token buckets and the gate, Live Activity merging, the push client's signing);
  what the two suites both checked through a socket stays in `contract/`.
- **`apps/relay/README.md` is the contract and the manual**: the wire format, limits and log
  lines, then running, layout, tests and the load generator.

## Considered Options

- **Keeping the Bun build as a reference.** A reference nobody runs drifts. The contract is
  the README and the suite, and both outlive the build they were written beside.
- **A separate `packages/relay-contract` for the TypeScript suite.** It would be a package
  whose only subject is another directory. One directory, one owner.
- **Prebuilt relay binaries for tests**, fetched instead of built. A cold build is about half
  a minute on a laptop and the tests then always run the sources in the checkout.

## Consequences

- Working on the Daemon's Linked Device tests, the Mobile App's relay tests or the relay
  needs a Rust toolchain: rustup, which fetches the version `apps/relay/rust-toolchain.toml`
  pins. Nothing else in the repository does.
- CI builds the binary once per runner OS and relay source state
  (`.github/actions/relay-binary`, cached) for the test jobs. The `relay` job runs
  `cargo fmt --check`, clippy and the Rust tests.
- The Daemon and the Mobile App declare `@polaris/relay` as a dev dependency, so a relay
  change now runs their suites on a pull request.
- The relay must build on Windows, where the Daemon's suite starts it: it stops on Ctrl-C
  there, having no SIGTERM.
- Measuring a change means two checkouts or two binaries (`relay-bench run --target <command>`),
  not two builds in one tree.
- The Railway service builds `apps/relay/Dockerfile` and watches `apps/relay/src/**`, the Cargo
  files and the Dockerfile. Those settings live on the service.
